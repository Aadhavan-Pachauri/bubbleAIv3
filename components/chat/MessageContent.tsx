
import React from 'react';
import { CodeBlock } from '../ui/CodeBlock';
import { ClipboardDocumentIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

// Enhanced Table Renderer for Excel compatibility
const MarkdownTable: React.FC<{ markdown: string }> = ({ markdown }) => {
    const { isCopied, copy } = useCopyToClipboard('');

    const parseTable = () => {
        const lines = markdown.trim().split('\n');
        if (lines.length < 2) return null;

        // Filter out the separator line (contains ---)
        const headerLine = lines[0];
        const alignmentLine = lines[1];
        const dataLines = lines.slice(2);

        const headers = headerLine.split('|').slice(1, -1).map(h => h.trim());
        const alignments = alignmentLine.split('|').slice(1, -1).map(a => {
            const trim = a.trim();
            if (trim.startsWith(':') && trim.endsWith(':')) return 'center';
            if (trim.endsWith(':')) return 'right';
            return 'left';
        });

        const rows = dataLines.map(line => {
            // Handle potentially escaped pipes or messy markdown
            return line.split('|').slice(1, -1).map(c => c.trim());
        });

        return { headers, alignments, rows };
    };

    const tableData = parseTable();
    if (!tableData) return <p>{markdown}</p>;

    // Function to handle "Copy as Table" for Excel
    const handleCopyTable = () => {
        // Construct a tab-separated string for Excel/Sheets
        const headerStr = tableData.headers.join('\t');
        const rowsStr = tableData.rows.map(row => row.join('\t')).join('\n');
        const tsv = `${headerStr}\n${rowsStr}`;
        
        navigator.clipboard.writeText(tsv).then(() => {
            // We reuse the hook's state logic via a manual trigger if we refactored, 
            // but here we just use the hook for the icon state if we passed the text.
            // Since TSV generation is dynamic, we just rely on the parent logic or a simple alert/toast in a real app.
            // For now, let's just use the hook's copy function with the raw text to trigger the visual feedback
            copy(); 
            // Actually overwrite the clipboard with TSV immediately after
            navigator.clipboard.writeText(tsv);
        });
    };

    return (
        <div className="my-6 not-prose">
            <div className="flex justify-end mb-1">
                <button 
                    onClick={handleCopyTable}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-gray-400 hover:text-white bg-white/5 hover:bg-white/10 rounded transition-colors"
                    title="Copy for Excel/Sheets"
                >
                    {isCopied ? <ClipboardDocumentCheckIcon className="w-4 h-4 text-green-400" /> : <ClipboardDocumentIcon className="w-4 h-4" />}
                    <span>{isCopied ? 'Copied!' : 'Copy Table'}</span>
                </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-700 bg-[#1e1e1e] shadow-sm">
                {/* 
                    Using strictly standard HTML table styles for maximum copy-paste compatibility.
                    The 'border-collapse' is key for Excel.
                */}
                <table 
                    className="w-full text-sm text-left text-gray-300 border-collapse" 
                    style={{ borderCollapse: 'collapse' }}
                >
                    <thead className="text-xs uppercase bg-gray-800 text-gray-200">
                        <tr>
                            {tableData.headers.map((h, i) => (
                                <th key={i} className="px-6 py-3 border-b border-r border-gray-700 last:border-r-0 font-bold tracking-wider">
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="bg-[#1e1e1e]">
                        {tableData.rows.map((row, i) => (
                            <tr key={i} className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors">
                                {row.map((cell, j) => (
                                    <td 
                                        key={j} 
                                        className={`px-6 py-4 border-r border-gray-800 last:border-r-0 ${
                                            tableData.alignments[j] === 'center' ? 'text-center' : 
                                            tableData.alignments[j] === 'right' ? 'text-right' : 'text-left'
                                        }`}
                                    >
                                        {cell}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

// Enhanced renderer for markdown headers, citations, and highlighting
const TextRenderer: React.FC<{ text: string; highlight: string; onPreviewHtml?: (code: string) => void }> = ({ text, highlight, onPreviewHtml }) => {
    // Detect Table Block
    // Matches standard markdown tables: | Header | ... \n | --- | ...
    if (text.match(/^\s*\|(.+)\|\s*\n\s*\|([-:| ]+)\|/)) {
        return <MarkdownTable markdown={text} />;
    }

    // 1. Split by newlines to handle block-level elements like headers
    const lines = text.split('\n');

    return (
        <>
            {lines.map((line, i) => {
                const trimmed = line.trim();
                // Handle Headers - stricter check to avoid false positives
                if (trimmed.startsWith('### ')) {
                    return <h3 key={i} className="text-lg font-bold text-white mt-4 mb-2 tracking-tight">{renderInline(trimmed.slice(4), highlight)}</h3>;
                }
                if (trimmed.startsWith('## ')) {
                    return <h2 key={i} className="text-xl font-bold text-white mt-6 mb-3 border-b border-white/10 pb-1 tracking-tight">{renderInline(trimmed.slice(3), highlight)}</h2>;
                }
                if (trimmed.startsWith('# ')) {
                    return <h1 key={i} className="text-2xl font-extrabold text-white mt-6 mb-4 tracking-tight">{renderInline(trimmed.slice(2), highlight)}</h1>;
                }
                
                // Standard paragraph or empty line
                // Use min-h for empty lines to preserve spacing
                return (
                    <p key={i} className={`mb-1 leading-relaxed ${line.trim() === '' ? 'min-h-[0.5rem]' : ''}`}>
                        {renderInline(line, highlight)}
                    </p>
                );
            })}
        </>
    );
};

// Helper to render inline markdown (bold, italic, citations, highlight)
const renderInline = (text: string, highlight: string): React.ReactNode[] => {
    // Regex breakdown:
    // 1. Citations: \[(\d+)\] -> matches [1], [2]
    // 2. Bold/Italic: Standard markdown patterns
    const regex = /(\[\d+\])|(\*\*\*[\s\S]+?\*\*\*|\*\*[\s\S]+?\*\*|\*[\s\S]+?\*|___[\s\S]+?___|__[\s\S]+?__|_[\s\S]+?_)/g;
    
    const parts = text.split(regex);

    return parts.map((part, index) => {
        if (!part) return null;

        // Citation Handling
        if (/^\[\d+\]$/.test(part)) {
            return (
                <sup key={index} className="citation ml-0.5 text-[10px] font-bold text-blue-400 cursor-pointer select-none bg-blue-500/10 px-1 rounded-sm hover:bg-blue-500/30 hover:text-blue-300 transition-colors" title="Source Reference">
                    {part}
                </sup>
            );
        }

        // Markdown Formatting
        if (part.startsWith('***') && part.endsWith('***')) return <strong key={index}><em>{applyHighlight(part.slice(3, -3), highlight)}</em></strong>;
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{applyHighlight(part.slice(2, -2), highlight)}</strong>;
        if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{applyHighlight(part.slice(1, -1), highlight)}</em>;
        if (part.startsWith('___') && part.endsWith('___')) return <strong key={index}><em>{applyHighlight(part.slice(3, -3), highlight)}</em></strong>;
        if (part.startsWith('__') && part.endsWith('__')) return <strong key={index}>{applyHighlight(part.slice(2, -2), highlight)}</strong>;
        if (part.startsWith('_') && part.endsWith('_')) return <em key={index}>{applyHighlight(part.slice(1, -1), highlight)}</em>;

        return applyHighlight(part, highlight);
    });
};

const applyHighlight = (str: string, highlight: string): React.ReactNode[] => {
    if (!highlight.trim()) return [str];
    const highlightRegex = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = str.split(highlightRegex);
    return parts.map((p, i) => highlightRegex.test(p) ? <mark key={i} className="bg-yellow-400 text-black rounded px-0.5">{p}</mark> : p);
};

interface MessageContentProps {
  content: string;
  searchQuery: string;
  sender: 'user' | 'ai';
  isTyping?: boolean;
  onPreviewHtml?: (code: string) => void;
}

// Regex to identify code blocks (```...```)
const codeBlockRegex = /```(\w+)?(?::(\S+))?\s*([\s\S]*?)```/g;
const splitRegex = /(```(?:\w+)?(?::\S+)?\s*[\s\S]*?```)/g;

export const MessageContent: React.FC<MessageContentProps> = ({ content, searchQuery, sender, isTyping = false, onPreviewHtml }) => {
  if (!content && !isTyping) return null;

  const parts = content.split(splitRegex);

  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;

        const match = [...part.matchAll(codeBlockRegex)][0];
        
        if (match) {
          const language = match[1] || 'plaintext';
          const filename = match[2] || null;
          const code = match[3].trim();
          
          return (
            <div key={index} className="not-prose my-4">
                <CodeBlock code={code} language={language} filename={filename} onPreview={onPreviewHtml ? () => onPreviewHtml(code) : undefined} />
            </div>
          );
        } else {
          return <div key={index} className="prose-text"><TextRenderer text={part} highlight={searchQuery} onPreviewHtml={onPreviewHtml} /></div>;
        }
      })}
      {isTyping && sender === 'ai' && (
        <span className="inline-block w-0.5 h-5 align-bottom bg-text-primary animate-blink ml-1" />
      )}
    </>
  );
};
