
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from './useToast';
import { Project, Message, Chat, WorkspaceMode, ChatWithProjectData } from '../types';
import { 
    getAllChatsForUser, 
    addMessage, 
    updateChat as updateDbChat, 
    getMessages, 
    deleteChat, 
    updateMessagePlan,
    getChatsForProject,
} from '../services/databaseService';
import { generateChatTitle } from '../services/geminiService';
import { runAgent } from '../agents';
import { User } from '@supabase/supabase-js';
import { AgentExecutionResult } from '../agents/types';
import { NEW_CHAT_NAME } from '../constants';
import mammoth from 'https://esm.sh/mammoth@1.6.0';
import JSZip from 'https://esm.sh/jszip@3.10.1';

const DUMMY_AUTONOMOUS_PROJECT: Project = {
  id: 'autonomous-project',
  user_id: 'unknown',
  name: 'Autonomous Chat',
  description: 'A personal chat with the AI.',
  status: 'In Progress',
  platform: 'Web App',
  project_type: 'conversation',
  default_model: 'gemini-2.5-flash',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

interface UseChatProps {
    user: User | null;
    geminiApiKey: string | null;
    workspaceMode: WorkspaceMode;
    adminProject?: Project | null; 
}

const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            const result = reader.result as string;
            // Remove the data URL prefix (e.g., "data:image/png;base64,")
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = error => reject(error);
    });
};

const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = error => reject(error);
        reader.readAsText(file);
    });
}

// Interface for structured attachments
interface Attachment {
    type: string;
    data: string; // Base64 or text content
    name: string;
}

export const useChat = ({ user, geminiApiKey, workspaceMode, adminProject }: UseChatProps) => {
    const { supabase, profile } = useAuth();
    const { addToast } = useToast();

    const [allChats, setAllChats] = useState<ChatWithProjectData[]>([]);
    const [activeChat, setActiveChat] = useState<ChatWithProjectData | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isCreatingChat, setIsCreatingChat] = useState(false);
    
    // Ref to track if we are currently awaiting a response to prevent duplicate fetches
    const isSendingRef = useRef(false);
    // Ref to ensure we don't process stale effect calls for old chats
    const activeChatIdRef = useRef<string | null>(null);

    useEffect(() => {
        activeChatIdRef.current = activeChat?.id || null;
    }, [activeChat]);

    const activeProject = useMemo(() => adminProject ?? activeChat?.projects ?? null, [adminProject, activeChat]);
    
    // Fetch chats
    useEffect(() => {
        if (!supabase || !user) return;
        const fetchChats = async () => {
            setIsLoading(true);
            try {
                let chats: ChatWithProjectData[] = [];
                if (adminProject) {
                    const projectChats = await getChatsForProject(supabase, adminProject.id);
                    chats = projectChats.map(c => ({...c, projects: adminProject }));
                } else if(user) {
                    chats = await getAllChatsForUser(supabase, user.id);
                }
                setAllChats(chats);
            } catch (error) {
                console.error("Error fetching chats:", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchChats();
    }, [user, supabase, addToast, adminProject]);

    // Fetch messages with smart merging
    useEffect(() => {
        let isMounted = true;

        const fetchMessages = async () => {
            if (activeChat && supabase) {
                const chatId = activeChat.id;
                // Don't show loading spinner if we are just sending a message, improves UX
                if (!isSendingRef.current) setIsLoading(true);
                
                try {
                    const history = await getMessages(supabase, chatId);
                    
                    // Ensure we are still looking at the same chat before updating state
                    if (isMounted && activeChatIdRef.current === chatId) {
                        setMessages(prev => {
                            // Find optimistic messages (temp-*) that are NOT yet in the DB history
                            const pendingOptimistic = prev.filter(p => p.id.startsWith('temp-'));
                            
                            if (pendingOptimistic.length > 0) {
                                // Deduplicate: If the EXACT text and sender is at the end of history, remove the temp one.
                                const lastDbMsg = history[history.length - 1];
                                const uniqueOptimistic = pendingOptimistic.filter(opt => {
                                    if (lastDbMsg && lastDbMsg.text === opt.text && lastDbMsg.sender === opt.sender) {
                                        return false;
                                    }
                                    return true;
                                });

                                return [...history, ...uniqueOptimistic];
                            }
                            return history;
                        });
                    }
                } catch (error) { 
                    console.error("Error fetching messages:", error);
                } 
                finally { 
                    if (isMounted) setIsLoading(false); 
                }
            } else {
                if (isMounted) setMessages([]);
            }
        };

        fetchMessages();
        
        let channel: any = null;
        if (activeChat && supabase) {
            channel = supabase.channel(`chat:${activeChat.id}`)
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${activeChat.id}` }, (payload) => {
                    if (!isMounted) return;
                    const newMsg = payload.new as Message;
                    setMessages(prev => {
                        if (prev.some(m => m.id === newMsg.id)) return prev;
                        
                        const filtered = prev.filter(m => {
                            if (!m.id.startsWith('temp-')) return true;
                            // If we have a temp message with same text/sender, assume this INSERT is the saved version
                            return !(m.text === newMsg.text && m.sender === newMsg.sender);
                        });
                        return [...filtered, newMsg];
                    });
                })
                .subscribe();
        }

        return () => { 
            isMounted = false;
            if (channel) supabase.removeChannel(channel); 
        };
    }, [activeChat?.id, supabase]);

    const handleSelectChat = useCallback((chat: ChatWithProjectData) => {
        setActiveChat(chat);
    }, []);

    const handleUpdateChat = useCallback(async (chatId: string, updates: Partial<Chat>) => {
        if (!supabase) return;
        try {
            // @ts-ignore
            const updatedChat = await updateDbChat(supabase, chatId, updates);
            // @ts-ignore
            setAllChats(prev => prev.map(c => c.id === chatId ? { ...c, ...updatedChat } : c));
            // @ts-ignore
            setActiveChat(prev => (prev?.id === chatId ? { ...prev, ...updatedChat } : prev));
        } catch (error) { 
             console.error("Failed to update chat:", error);
        }
    }, [supabase]);

    const handleDeleteChat = async (chatId: string) => {
        if (!supabase) return;
        try {
            await deleteChat(supabase, chatId);
            setAllChats(prev => prev.filter(c => c.id !== chatId));
            if (activeChat?.id === chatId) setActiveChat(null);
            addToast('Chat deleted.', 'info');
        } catch (error) {
            addToast('Failed to delete chat.', 'error');
        }
    };
    
    const handleSendMessage = useCallback(async (
        text: string, 
        files: File[] | null = null, 
        chatToUse: ChatWithProjectData | null = activeChat,
        modelOverride?: string,
        onProjectFileUpdate?: (path: string, content: string, isComplete: boolean) => void
    ): Promise<AgentExecutionResult> => {
      // Allow sending if there are files, even if text is empty.
      if ((!text.trim() && (!files || files.length === 0)) || !supabase || !user || !chatToUse || !geminiApiKey) return { messages: [] };
      
      if (isSendingRef.current) return { messages: [] };
      isSendingRef.current = true;

      const tempId = `temp-ai-${Date.now()}`;
      const tempUserMsgId = `temp-user-${Date.now()}`;
      let currentText = '';

      try {
        let processedPrompt = text;
        const attachments: Attachment[] = []; // Stores formatted attachments for DB (UI display)
        const agentFiles: File[] = []; // Files to be passed to agent handler (Binary payloads)

        // File Processing
        if (files && files.length > 0) {
            for (const file of files) {
                const mimeType = file.type;
                const fileName = file.name.toLowerCase();
                
                // 1. IMAGES
                const isImage = mimeType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(fileName);
                
                // 2. PDFs
                const isPDF = mimeType === 'application/pdf' || fileName.endsWith('.pdf');
                
                // 3. DOCX (Word)
                const isDocx = fileName.endsWith('.docx');
                
                // 4. ZIP Archives
                const isZip = mimeType.includes('zip') || fileName.endsWith('.zip');

                // 5. Readable Text / Code
                const isReadableText = mimeType.startsWith('text/') || 
                    fileName.match(/\.(txt|md|json|js|jsx|ts|tsx|lua|html|css|scss|less|py|java|c|cpp|h|cs|csv|xml|yml|yaml|rb|go|php|sh|bat|ini|cfg|env|sql)$/i);

                if (isImage) {
                    const b64 = await fileToBase64(file);
                    attachments.push({ type: mimeType || 'image/jpeg', data: b64, name: file.name });
                    agentFiles.push(file); // Pass binary to agent
                } 
                else if (isPDF) {
                    const b64 = await fileToBase64(file);
                    attachments.push({ type: 'application/pdf', data: b64, name: file.name });
                    agentFiles.push(file); // Pass binary to agent (Gemini supports PDF natively)
                }
                else if (isDocx) {
                    let textContent = '';
                    let errorMsg = '';
                    
                    try {
                        const arrayBuffer = await file.arrayBuffer();
                        // Validate ZIP signature (PK) which DOCX uses
                        const arr = new Uint8Array(arrayBuffer).subarray(0, 2);
                        if (arr[0] === 0x50 && arr[1] === 0x4B) { // 'PK'
                             const result = await mammoth.extractRawText({ arrayBuffer });
                             textContent = result.value;
                        } else {
                             errorMsg = "File is missing ZIP signature. May be corrupted.";
                        }
                    } catch (e: any) {
                        console.error("DOCX extraction failed", e);
                        errorMsg = e.message || "Failed to read DOCX";
                    }

                    if (textContent) {
                        processedPrompt += `\n\n<file_attachment name="${file.name}">\n${textContent}\n</file_attachment>\n`;
                        attachments.push({ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: '', name: file.name });
                    } else {
                        // Fallback: Try reading as a plain ZIP if standard DOCX parsing failed
                        try {
                            const zip = await JSZip.loadAsync(file);
                            let zipContent = `\n[Fallback: Reading DOCX as Archive]\n`;
                            // Look for document.xml or similar manually if needed, or just list files
                            const docXml = zip.file("word/document.xml");
                            if (docXml) {
                                const xmlText = await docXml.async("string");
                                // Very crude XML text extraction (strips tags)
                                const rawText = xmlText.replace(/<[^>]+>/g, ' ');
                                processedPrompt += `\n\n<file_attachment name="${file.name} (recovered)">\n${rawText}\n</file_attachment>\n`;
                                attachments.push({ type: 'application/zip', data: '', name: file.name + " (recovered)" });
                            } else {
                                throw new Error("Could not find document body in archive.");
                            }
                        } catch (zipErr) {
                             addToast(`Could not read ${file.name}. ${errorMsg}`, 'error');
                             processedPrompt += `\n[User attached file: ${file.name} (Read Failed)]\n`;
                        }
                    }
                }
                else if (isZip) {
                    try {
                        const zip = await JSZip.loadAsync(file);
                        let extractedContent = "";
                        const maxFiles = 10;
                        let fileCount = 0;

                        // Iterate through zip contents
                        for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
                            // Cast to any to avoid typescript errors with imported JSZip types
                            const entry = zipEntry as any;
                            if (entry.dir || relativePath.startsWith('__MACOSX') || relativePath.includes('.DS_Store')) continue;
                            
                            // Only read text-like files
                            if (relativePath.match(/\.(txt|md|json|js|ts|py|lua|html|css|xml|yaml)$/i)) {
                                if (fileCount < maxFiles) {
                                    const text = await entry.async("string");
                                    extractedContent += `\n--- File: ${relativePath} ---\n${text.substring(0, 10000)}\n`; // Limit size per file
                                    fileCount++;
                                }
                            }
                        }
                        
                        if (extractedContent) {
                            processedPrompt += `\n\n<zip_archive name="${file.name}">\n${extractedContent}\n</zip_archive>\n`;
                            attachments.push({ type: 'application/zip', data: '', name: file.name });
                        } else {
                            addToast(`No readable text files found in ${file.name}.`, 'info');
                        }
                    } catch (e) {
                        console.error("ZIP read failed", e);
                        addToast(`Failed to read ZIP archive: ${file.name}`, 'error');
                    }
                }
                else if (isReadableText) {
                    try {
                        const content = await readFileAsText(file);
                        // Append content strictly to the prompt
                        processedPrompt += `\n\n<file_attachment name="${file.name}">\n${content}\n</file_attachment>\n`;
                        // Visual cue in UI
                        attachments.push({ type: 'text/plain', data: '', name: file.name });
                    } catch (e) {
                        addToast(`Could not read text file ${file.name}.`, 'error');
                    }
                } 
                else {
                    // Unknown binary files (PPTX, Keynote, etc.)
                    // Attempt to send as generic binary if small enough, or just fail gracefully
                    try {
                        // For unsupported types, we can try sending as image/pdf if user insists, but usually better to just attach
                        // For now, we'll try to treat it as a blob for Gemini (it might handle it or reject it)
                        // If it's a PPTX, often Gemini won't take it directly in generateContent yet without File API (which requires upload).
                        // Since we are using inlineData, we are limited.
                        // We will skip sending binary for unsupported types to avoid API errors, but show it in UI.
                        addToast(`File type ${mimeType} is not fully supported for reading. Sending filename only.`, 'info');
                        processedPrompt += `\n[User attached file: ${file.name} (Type: ${mimeType || 'unknown'})]\n`;
                        attachments.push({ type: mimeType || 'application/octet-stream', data: '', name: file.name });
                    } catch (e) {
                        processedPrompt += `\n[User attached file: ${file.name} (Read Failed)]\n`;
                    }
                }
            }
        }

        // Use a placeholder text if user sent only files so the UI message isn't empty
        const displayText = text.trim() === '' && files && files.length > 0 ? "" : text;

        const userMessageData: Omit<Message, 'id' | 'created_at'> = {
          project_id: chatToUse.project_id,
          chat_id: chatToUse.id,
          // @ts-ignore
          user_id: user.id, 
          text: displayText, // Save what the user sees
          sender: 'user',
        };

        // Store structured attachments in image_base64 field (serialized JSON)
        if (attachments.length > 0) {
            userMessageData.image_base64 = JSON.stringify(attachments);
        }
        
        const optimisticUserMessage: Message = { ...userMessageData, id: tempUserMsgId, created_at: new Date().toISOString() };
        const tempAiMessage: Message = { id: tempId, project_id: chatToUse.project_id, chat_id: chatToUse.id, text: '', sender: 'ai' };
        
        setMessages(prev => [...prev, optimisticUserMessage, tempAiMessage]);
        
        let savedUserMessage: Message;
        try {
            savedUserMessage = await addMessage(supabase, userMessageData);
            setMessages(prev => prev.map(m => m.id === tempUserMsgId ? savedUserMessage : m));
        } catch (dbError) {
             console.error("Failed to save user message:", dbError);
             savedUserMessage = optimisticUserMessage; 
        }

        // Use the PROCESSED prompt (with file contents) for the agent history context
        // But keep the UI history clean. We create a "virtual" history for the agent.
        const agentHistory = messages.map(m => m);
        // We don't add the current user message to history here because runAgent adds it to the end of contents manually
        
        const onStreamChunk = (chunk: string) => {
            try {
                if (chunk.includes('image_generation_start')) {
                     const match = chunk.match(/\{.*"type":\s*"image_generation_start".*\}/);
                     if (match) {
                         setMessages(prev => prev.map(m => m.id === tempId ? { ...m, imageStatus: 'generating' } : m));
                         const textPart = chunk.replace(match[0], '');
                         if (textPart) {
                             currentText += textPart;
                             setMessages(prev => prev.map(m => m.id === tempId ? { ...m, text: currentText } : m));
                         }
                         return;
                     }
                }
            } catch (e) {}
            
            currentText += chunk;
            setMessages(prev => prev.map(m => m.id === tempId ? { ...m, text: currentText, imageStatus: undefined } : m));
        };

        const projectForAgent = chatToUse.projects ?? { ...DUMMY_AUTONOMOUS_PROJECT, user_id: user.id };
        
        const preferredModel = workspaceMode === 'cocreator' 
            ? (profile?.preferred_code_model || profile?.preferred_chat_model) 
            : profile?.preferred_chat_model;
            
        let modelToUse = modelOverride || preferredModel || projectForAgent.default_model;
        
        // Safety fallback for model
        if (!modelToUse || modelToUse === '') modelToUse = 'gemini-2.5-flash';

        // CRITICAL: Pass processedPrompt to the agent, not the original text
        const agentResult = await runAgent({
            prompt: processedPrompt, // Contains file contents
            files: agentFiles, // Contains binary files (PDF/Image)
            apiKey: geminiApiKey, 
            model: modelToUse,
            project: projectForAgent, 
            chat: chatToUse, 
            user, 
            profile, 
            supabase,
            history: agentHistory, 
            onStreamChunk, 
            onFileUpdate: onProjectFileUpdate,
            workspaceMode
        });
        
        const { messages: agentMessages, updatedPlan } = agentResult;
        
        const savedAiMessages: Message[] = [];
        for (const messageContent of agentMessages) {
            const finalContent = messageContent.text || currentText; 
            try {
                const savedAiMessage = await addMessage(supabase, { 
                    ...messageContent, 
                    text: finalContent, 
                    project_id: chatToUse.project_id,
                    model: modelToUse 
                });
                savedAiMessages.push(savedAiMessage);
            } catch (aiDbError) {
                console.error("Failed to save AI message:", aiDbError);
                savedAiMessages.push({ ...messageContent, id: `failed-${Date.now()}`, text: finalContent, created_at: new Date().toISOString() } as Message);
                addToast("Failed to save AI response to history.", "error");
            }
        }
        
        setMessages(prev => {
            const newMessages = [...prev];
            const tempMessageIndex = newMessages.findIndex(m => m.id === tempId);
            
            if (tempMessageIndex !== -1) {
                if (savedAiMessages.length > 0) {
                    newMessages.splice(tempMessageIndex, 1, ...savedAiMessages);
                } else {
                    newMessages.splice(tempMessageIndex, 1);
                }
            } else {
                 newMessages.push(...savedAiMessages);
            }
            
            if (updatedPlan) {
                return newMessages.map(m => m.id === updatedPlan.messageId ? { ...m, plan: updatedPlan.plan } : m);
            }
            return newMessages;
        });

        if (updatedPlan) await updateMessagePlan(supabase, updatedPlan.messageId, updatedPlan.plan);

        // Title Generation Trigger
        if (chatToUse.name === NEW_CHAT_NAME) {
            try {
                const userContentForTitle = text.trim() || (files && files.length > 0 ? "Analyzed uploaded files" : "New Chat");
                const aiContentForTitle = savedAiMessages.length > 0 ? savedAiMessages[0].text : currentText || "Response";
                
                if (aiContentForTitle) {
                    const newTitle = await generateChatTitle(userContentForTitle, aiContentForTitle, geminiApiKey);
                    if (newTitle && newTitle !== "New Chat") {
                        await handleUpdateChat(chatToUse.id, { name: newTitle });
                    }
                }
            } catch (titleError) {
                console.warn("Failed to auto-generate chat title:", titleError);
            }
        }
        
        return agentResult;

      } catch (e: any) {
        const errorMessage = e?.message || "An unknown error occurred.";
        addToast(errorMessage, "error");
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, text: `⚠️ Error: ${errorMessage}`, sender: 'ai' } : m));
        return { messages: [] };
      } finally {
        isSendingRef.current = false;
      }
    }, [activeChat, supabase, user, geminiApiKey, messages, addToast, profile, workspaceMode, handleUpdateChat]);
    
    return {
        allChats, setAllChats, activeChat, setActiveChat, messages, setMessages,
        isLoading, isCreatingChat, setIsCreatingChat, activeProject,
        handleUpdateChat, handleSelectChat, handleDeleteChat, handleSendMessage,
    };
};
