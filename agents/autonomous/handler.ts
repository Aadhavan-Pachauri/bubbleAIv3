
import { GoogleGenAI } from "@google/genai";
import { AgentInput, AgentExecutionResult } from '../types';
import { getUserFriendlyError } from '../errorUtils';
import { generateImage } from '../../services/geminiService';
import { incrementThinkingCount } from '../../services/databaseService';
import { researchService } from "../../services/researchService";
import { BubbleSemanticRouter, RouterAction } from "../../services/semanticRouter";
import { Memory5Layer } from "../../services/memoryService";
import { autonomousInstruction } from './instructions';
import { runCanvasAgent } from "../canvas/handler";

const formatTimestamp = () => {
    return new Date().toLocaleString(undefined, { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', 
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' 
    });
};

// Helper to check if model is native Google Gemini
const isGoogleModel = (model: string) => {
    if (!model) return true; // Default safety
    return model.startsWith('gemini') || model.startsWith('veo') || model.includes('google');
};

// Helper for OpenRouter Streaming with improved error handling
async function* streamOpenRouter(apiKey: string, model: string, messages: any[], systemInstruction: string) {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://bubble.ai", // Required by OpenRouter
                "X-Title": "Bubble AI"
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: systemInstruction },
                    ...messages
                ],
                stream: true
            })
        });

        if (!response.ok) {
            let errorMsg = `OpenRouter Error (${response.status})`;
            try {
                const errorData = await response.json();
                // Graceful handling for "No allowed providers" (404)
                if (response.status === 404 && (errorData.error?.message?.includes("No allowed providers") || errorData.error?.code === 404)) {
                    throw new Error(`The model "${model}" is currently unavailable via OpenRouter (No providers). Please select a different model.`);
                }
                // Generic OpenRouter message
                if (errorData.error?.message) {
                    errorMsg = errorData.error.message;
                }
            } catch (e) {
                if (e instanceof Error && e.message.includes("currently unavailable")) throw e;
                // Fallback if JSON parse fails
                const textError = await response.text().catch(() => "");
                if (textError) errorMsg += `: ${textError}`;
            }
            throw new Error(errorMsg);
        }

        if (!response.body) throw new Error("No response body from OpenRouter");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.startsWith("data: ") && line !== "data: [DONE]") {
                    try {
                        const json = JSON.parse(line.substring(6));
                        const content = json.choices[0]?.delta?.content;
                        if (content) yield { text: content };
                    } catch (e) {}
                }
            }
        }
    } catch (error: any) {
        // If it's the user-friendly error we threw above, rethrow it to be caught by the main handler
        throw error;
    }
}

// Helper for retrying Native Gemini calls
const generateContentStreamWithRetry = async (
    ai: GoogleGenAI, 
    params: any, 
    retries = 3,
    onRetry?: (msg: string) => void
) => {
    // Safety check for model parameter
    if (!params.model) {
        console.warn("Model undefined in generateContent call, defaulting to gemini-2.5-flash");
        params.model = 'gemini-2.5-flash';
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await ai.models.generateContentStream(params);
        } catch (error: any) {
            const isQuotaError = error.status === 429 || 
                                 (error.message && error.message.includes('429')) ||
                                 (error.message && error.message.includes('quota'));
            
            if (isQuotaError && attempt < retries) {
                const delay = Math.pow(2, attempt) * 2000 + 1000; // 3s, 5s, 9s
                console.warn(`Quota limit hit. Retrying in ${delay}ms...`);
                if (onRetry) onRetry(`(Rate limit hit. Retrying in ${Math.round(delay/1000)}s...)`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
    throw new Error("Max retries exceeded");
};

export const runAutonomousAgent = async (input: AgentInput): Promise<AgentExecutionResult> => {
    let { prompt, files, apiKey, project, chat, history, supabase, user, profile, onStreamChunk, model } = input;
    
    // Ensure model is valid
    if (!model || model.trim() === '') {
        model = 'gemini-2.5-flash';
    }

    try {
        const isNative = isGoogleModel(model);
        const openRouterKey = profile?.openrouter_api_key;

        // If it's not native and we don't have an OR key, fail fast or fallback to Gemini
        if (!isNative && !openRouterKey) {
             onStreamChunk?.("\n*(OpenRouter key missing, falling back to Gemini...)*\n");
             model = 'gemini-2.5-flash';
        }

        const ai = new GoogleGenAI({ apiKey }); // apiKey is ALWAYS the Google key here
        const router = new BubbleSemanticRouter(supabase);
        const memory = new Memory5Layer(supabase, user.id);

        // 1. YouTube Short / Video Detection
        // If the prompt contains a YouTube link, we treat it as a specific SEARCH/ANALYSIS task.
        const youtubeMatch = prompt.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
        const youtubeShortMatch = prompt.match(/youtube\.com\/shorts\/([^"&?\/\s]{11})/);
        
        let initialAction: RouterAction | null = null;
        let initialParams: any = {};

        if (youtubeShortMatch || youtubeMatch) {
            const videoId = youtubeShortMatch ? youtubeShortMatch[1] : youtubeMatch![1];
            // Force a deep search for the video metadata specifically
            initialAction = 'SEARCH';
            // We modify the prompt to be a targeted search query for the video
            // This prevents the "hallucination" of generic tutorials
            const videoType = youtubeShortMatch ? "Short" : "Video";
            prompt = `Find details for YouTube ${videoType} ID: ${videoId}. Title, Channel, and Summary. URL: ${youtubeShortMatch ? youtubeShortMatch[0] : youtubeMatch![0]}`;
        }

        // 2. Default Route (if not overridden by regex above)
        const fileCount = files ? files.length : 0;
        // We use the Semantic Router (which uses a lightweight Gemini call usually) to decide action
        let routing = await router.route(prompt, user.id, apiKey, fileCount);
        
        if (initialAction) {
            routing.action = initialAction;
            routing.parameters = initialParams;
        }
        
        // 3. Gather Context
        const memoryContext = await memory.getContext([
            'inner_personal', 'outer_personal', 'personal', 
            'interests', 'preferences', 'custom', 
            'codebase', 'aesthetic', 'project'
        ]);
        const dateTimeContext = `[CURRENT DATE & TIME]\n${formatTimestamp()}\n`;
        
        // 4. Inject Model Identity & Instructions
        const rawModelName = model.split('/').pop() || model;
        const friendlyModelName = rawModelName
            .replace(/-/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase());
            
        const modelIdentityBlock = `You are currently running on the model: **${friendlyModelName}**.\nIf the user asks "Which AI model are you?", reply that you are Bubble, running on ${friendlyModelName}.`;
        const baseSystemInstruction = autonomousInstruction.replace('[MODEL_IDENTITY_BLOCK]', modelIdentityBlock);

        let finalResponseText = '';
        let metadataPayload: any = {};
        let fallbackSearchContext = ''; // Store search context for fallback
        
        let currentAction: RouterAction = routing.action;
        let currentPrompt = prompt;
        let loopCount = 0;
        const MAX_LOOPS = 6; // Allow up to 6 hops (e.g. Simple -> Search -> Simple -> Think -> Simple)

        while (loopCount < MAX_LOOPS) {
            loopCount++;

            switch (currentAction) {
                case 'SEARCH':
                case 'DEEP_SEARCH': {
                    onStreamChunk?.("\nSearching sources... 🌐\n");
                    
                    // Pass the apiKey so the research service can use Gemini's Google Search tool
                    const result = await researchService.deepResearch(currentPrompt, apiKey, (msg) => {
                         onStreamChunk?.(`\n*${msg}*`);
                    });
                    
                    // Map the source URLs to groundingMetadata so the UI renders them as interactive buttons
                    if (result.sources && result.sources.length > 0) {
                        metadataPayload.groundingMetadata = result.sources.map(url => {
                            let hostname = 'Source';
                            try { hostname = new URL(url).hostname.replace('www.', ''); } catch {}
                            return { web: { uri: url, title: hostname } };
                        });
                    }

                    // Synthesize the response using the AI
                    // result.answer contains the grounded summary/context from the InternalSearchEngine
                    fallbackSearchContext = result.answer; 
                    const synthesisPrompt = `USER QUERY: ${currentPrompt}\n\nSEARCH CONTEXT:\n${fallbackSearchContext}\n\nINSTRUCTIONS: Synthesize a comprehensive answer to the user's query based ONLY on the provided search context. Cite sources using [1], [2] format where appropriate.`;
                    
                    // Fall through to 'SIMPLE' logic to generate the response using the active model
                    currentPrompt = synthesisPrompt;
                    currentAction = 'SIMPLE';
                    continue; 
                }

                case 'THINK': {
                    // Only Google models 2.5+ support thinking config natively
                    // For other models, we skip thinking to prevent errors
                    if (!isGoogleModel(model) || !model.includes('gemini-2.5')) {
                        currentAction = 'SIMPLE'; 
                        continue;
                    }

                    onStreamChunk?.("\nThinking deeply... 🧠\n");
                    await incrementThinkingCount(supabase, user.id);
                    
                    const geminiHistory = history.map(msg => ({
                        role: msg.sender === 'user' ? 'user' : 'model' as 'user' | 'model',
                        parts: [{ text: msg.text }],
                    })).filter(msg => msg.parts[0].text.trim() !== '');
                    
                    const contextBlock = `${baseSystemInstruction}\n\n${dateTimeContext}\n\n[MEMORY]\n${JSON.stringify(memoryContext)}\n\n[TASK]\n${currentPrompt}`;
                    const contents = [...geminiHistory, { role: 'user', parts: [{ text: contextBlock }] }];

                    const response = await generateContentStreamWithRetry(ai, {
                        model: model, 
                        contents,
                        config: {
                            thinkingConfig: { thinkingBudget: 2048 },
                        }
                    }, 3, (msg) => onStreamChunk?.(msg));

                    for await (const chunk of response) {
                        if (chunk.text) {
                            finalResponseText += chunk.text;
                            onStreamChunk?.(chunk.text);
                        }
                    }
                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }

                case 'IMAGE': {
                    onStreamChunk?.(JSON.stringify({ type: 'image_generation_start', text: finalResponseText }));
                    const imagePrompt = routing.parameters?.prompt || currentPrompt;
                    try {
                        const { imageBase64 } = await generateImage(imagePrompt, apiKey, profile?.preferred_image_model);
                        return { 
                            messages: [{ 
                                project_id: project.id, 
                                chat_id: chat.id, 
                                sender: 'ai', 
                                text: finalResponseText,
                                image_base64: imageBase64, 
                                ...metadataPayload 
                            }] 
                        };
                    } catch (e) {
                        const errorMsg = `\n\n(Image generation failed: ${e instanceof Error ? e.message : 'Unknown error'})`;
                        finalResponseText += errorMsg;
                        onStreamChunk?.(errorMsg);
                        return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                    }
                }

                case 'CANVAS': {
                    const canvasResult = await runCanvasAgent({
                        ...input,
                        prompt: currentPrompt
                    });
                    const canvasMessage = canvasResult.messages[0];
                    finalResponseText = canvasMessage.text || "";
                    return { messages: [{ 
                        project_id: project.id, 
                        chat_id: chat.id, 
                        sender: 'ai', 
                        text: finalResponseText, 
                        ...metadataPayload 
                    }] };
                }

                case 'PROJECT': {
                    if (!isGoogleModel(model)) {
                        currentAction = 'SIMPLE'; continue;
                    }
                    onStreamChunk?.("\nBuilding project structure... 🏗️\n");
                     const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: `Build a complete file structure for a project: ${currentPrompt}. Return a JSON object with filenames and brief content descriptions.`,
                        config: { responseMimeType: 'application/json' }
                    });
                    
                    const projectMsg = `\nI've designed the project structure based on your request.\n\n${response.text}\n\n(Switch to Co-Creator mode to fully hydrate and edit these files.)`;
                    finalResponseText += projectMsg;
                    onStreamChunk?.(projectMsg);
                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }
                
                case 'STUDY': {
                    if (!isGoogleModel(model)) {
                        currentAction = 'SIMPLE'; continue;
                    }
                    onStreamChunk?.("\nCreating study plan... 🎓\n");
                    const response = await generateContentStreamWithRetry(ai, {
                        model: 'gemini-2.5-flash',
                        contents: `Create a structured study plan for: ${currentPrompt}. Include learning objectives and key concepts.`,
                    }, 3, (msg) => onStreamChunk?.(msg));
                    
                    for await (const chunk of response) {
                        if (chunk.text) {
                            finalResponseText += chunk.text;
                            onStreamChunk?.(chunk.text);
                        }
                    }
                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }

                case 'SIMPLE':
                default: {
                    const systemPrompt = `${baseSystemInstruction}\n\n[MEMORY]\n${JSON.stringify(memoryContext)}\n\n${dateTimeContext}`;
                    
                    const historyWithoutLast = (history.length > 0 && history[history.length - 1].sender === 'user') 
                        ? history.slice(0, -1) 
                        : history;

                    const historyMessages = historyWithoutLast.map(msg => ({
                        role: msg.sender === 'user' ? 'user' : (isNative ? 'model' : 'assistant'),
                        content: msg.text, 
                        parts: [{ text: msg.text }] 
                    })).filter(msg => msg.parts[0].text.trim() !== '');

                    if (files && files.length > 0 && isNative) {
                        const userParts: any[] = [{ text: currentPrompt }];
                        for (const file of files) {
                            const base64EncodedData = await new Promise<string>((resolve, reject) => {
                                const reader = new FileReader();
                                reader.onload = () => {
                                    const res = reader.result as string;
                                    resolve(res.split(',')[1]);
                                };
                                reader.onerror = reject;
                                reader.readAsDataURL(file);
                            });
                            userParts.unshift({ inlineData: { data: base64EncodedData, mimeType: file.type } });
                        }
                        historyMessages.push({ role: 'user', parts: userParts, content: currentPrompt } as any);
                    } else {
                        historyMessages.push({ role: 'user', parts: [{ text: currentPrompt }], content: currentPrompt } as any);
                    }

                    let generator;
                    let usedFallback = false;

                    if (isNative) {
                        const contents = historyMessages.map(m => ({ role: m.role, parts: m.parts }));
                        generator = await generateContentStreamWithRetry(ai, {
                            model,
                            contents,
                            config: { systemInstruction: systemPrompt }
                        }, 3, (msg) => onStreamChunk?.(msg));
                    } else {
                        try {
                            const messages = historyMessages.map(m => ({ role: m.role, content: m.content }));
                            generator = streamOpenRouter(openRouterKey!, model, messages, systemPrompt);
                        } catch (orError: any) {
                            // FALLBACK LOGIC: If OpenRouter fails (e.g. 404), switch to Gemini immediately for this turn
                            if (orError.message && (orError.message.includes('unavailable') || orError.message.includes('404'))) {
                                console.warn("OpenRouter model failed, falling back to Gemini.", orError);
                                onStreamChunk?.(`\n*(Model ${model} unavailable, switching to Gemini...)*\n`);
                                const contents = historyMessages.map(m => ({ role: m.role, parts: m.parts }));
                                generator = await generateContentStreamWithRetry(ai, {
                                    model: 'gemini-2.5-flash', // Fallback model
                                    contents,
                                    config: { systemInstruction: systemPrompt }
                                }, 3, (msg) => onStreamChunk?.(msg));
                                usedFallback = true;
                            } else {
                                throw orError;
                            }
                        }
                    }

                    let generatedThisLoop = "";

                    for await (const chunk of generator) {
                        if (chunk.text) {
                            generatedThisLoop += chunk.text;
                            finalResponseText += chunk.text;
                            onStreamChunk?.(chunk.text);
                            
                            if (isNative || usedFallback) {
                                const candidate = (chunk as any).candidates?.[0];
                                if (candidate?.groundingMetadata?.groundingChunks) {
                                    if (!metadataPayload.groundingMetadata) metadataPayload.groundingMetadata = [];
                                    metadataPayload.groundingMetadata.push(...candidate.groundingMetadata.groundingChunks);
                                }
                            }
                        }
                    }
                    
                    const searchMatch = generatedThisLoop.match(/<SEARCH>(.*?)<\/SEARCH>/);
                    const deepMatch = generatedThisLoop.match(/<DEEP>(.*?)<\/DEEP>/) || generatedThisLoop.match(/<SEARCH>deep\s+(.*?)<\/SEARCH>/i);
                    const thinkMatch = generatedThisLoop.match(/<THINK>(.*?)<\/THINK>/) || generatedThisLoop.match(/<THINK>/);
                    const imageMatch = generatedThisLoop.match(/<IMAGE>(.*?)<\/IMAGE>/);
                    const projectMatch = generatedThisLoop.match(/<PROJECT>(.*?)<\/PROJECT>/);
                    const canvasMatch = generatedThisLoop.match(/<CANVAS>(.*?)<\/CANVAS>/);
                    const studyMatch = generatedThisLoop.match(/<STUDY>(.*?)<\/STUDY>/);

                    if (deepMatch) { currentAction = 'DEEP_SEARCH'; currentPrompt = deepMatch[1]; continue; }
                    if (searchMatch) { currentAction = 'SEARCH'; currentPrompt = searchMatch[1]; continue; }
                    if (thinkMatch) { currentAction = 'THINK'; currentPrompt = thinkMatch[1] ? thinkMatch[1].trim() : prompt; continue; }
                    if (imageMatch) { currentAction = 'IMAGE'; currentPrompt = imageMatch[1]; routing.parameters = { prompt: imageMatch[1] }; continue; }
                    if (projectMatch) { currentAction = 'PROJECT'; currentPrompt = projectMatch[1]; continue; }
                    if (canvasMatch) { currentAction = 'CANVAS'; currentPrompt = canvasMatch[1]; continue; }
                    if (studyMatch) { currentAction = 'STUDY'; currentPrompt = studyMatch[1]; continue; }
                    
                    if (!finalResponseText.trim() && fallbackSearchContext) {
                        finalResponseText = fallbackSearchContext;
                        onStreamChunk?.(fallbackSearchContext);
                    }

                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }
            }
        }
        
        return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };

    } catch (error: any) {
        console.error("Error in runAutonomousAgent:", error);
        const errorMessage = error.message && error.message.includes("OpenRouter") ? error.message : getUserFriendlyError(error);
        return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: `An error occurred: ${errorMessage}` }] };
    }
};
