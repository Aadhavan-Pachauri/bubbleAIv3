
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDownIcon, LightBulbIcon } from '@heroicons/react/24/outline';

interface CanvasThinkingDisplayProps {
    thinking: string;
    isTyping?: boolean;
}

export const CanvasThinkingDisplay: React.FC<CanvasThinkingDisplayProps> = ({ thinking, isTyping }) => {
    const [isOpen, setIsOpen] = useState(false);
    const isBuffering = thinking === '';

    // Auto-open if typing, auto-close when done (optional UX choice, keeps it dynamic)
    useEffect(() => {
        if (isTyping && !isOpen) {
            setIsOpen(true);
        } else if (!isTyping && isOpen) {
            // Keep open for a moment or close? Let's keep it open if it was open, user can close.
            // Or better: Auto-collapse on finish to keep chat clean.
            setIsOpen(false); 
        }
    }, [isTyping]);

    return (
        <div className="mb-3 max-w-2xl">
             <button
                onClick={() => setIsOpen(!isOpen)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-all w-full md:w-auto ${isOpen ? 'bg-white/10 text-white' : 'bg-transparent text-gray-500 hover:bg-white/5 hover:text-gray-300'}`}
                title="View reasoning process"
            >
                {/* Status Indicator */}
                <div className="relative flex items-center justify-center w-4 h-4">
                    {isTyping ? (
                        <>
                            <span className="absolute inline-flex h-full w-full rounded-full bg-primary-start opacity-75 animate-ping"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary-start"></span>
                        </>
                    ) : (
                        <LightBulbIcon className="w-4 h-4" />
                    )}
                </div>
                
                <span className="flex-1 text-left">
                    {isTyping ? 'Thinking...' : 'Reasoning Process'}
                </span>
                
                <ChevronDownIcon className={`w-3 h-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div 
                        initial={{ opacity: 0, height: 0 }} 
                        animate={{ opacity: 1, height: 'auto' }} 
                        exit={{ opacity: 0, height: 0 }} 
                        className="overflow-hidden"
                    >
                        <div className="mt-2 text-xs text-gray-300 font-mono whitespace-pre-wrap leading-relaxed bg-black/40 border-l-2 border-primary-start pl-4 py-3 pr-4 rounded-r-lg shadow-inner">
                            {isBuffering ? (
                                <div className="flex items-center gap-2 text-gray-500 animate-pulse">
                                    <div className="w-1.5 h-1.5 bg-gray-500 rounded-full"></div>
                                    <div className="w-1.5 h-1.5 bg-gray-500 rounded-full animation-delay-200"></div>
                                    <div className="w-1.5 h-1.5 bg-gray-500 rounded-full animation-delay-400"></div>
                                    <span>Analyzing request...</span>
                                </div>
                            ) : thinking}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
