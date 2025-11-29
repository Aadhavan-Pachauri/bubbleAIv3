
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { LeftSidebar } from './LeftSidebar';
import { ChatView } from '../chat/ChatView';
import { ProjectsPage } from '../pages/ProjectsPage';
import { TopBar } from '../dashboard/TopBar';
import { Project, Message, Chat, WorkspaceMode, ProjectPlatform, ProjectType, ChatWithProjectData } from '../../types';
import { SettingsPage } from '../pages/SettingsPage';
import { useAuth } from '../../contexts/AuthContext';
import { updateProject as updateDbProject, createProject, createChat as createDbChat, getAllChatsForUser, getChatsForProject } from '../../services/databaseService';
import { StatusBar } from '../admin/ImpersonationBanner';
import { CoCreatorWorkspace } from '../cocreator/CoCreatorWorkspace';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { generateProjectDetails, classifyUserIntent } from '../../services/geminiService';
import { useToast } from '../../hooks/useToast';
import { useChat } from '../../hooks/useChat';
import { useWindowSize } from '../../hooks/useWindowSize';

import { MarketplacePage } from '../community/MarketplacePage';
import { MessagesPage } from '../community/MessagesPage';
import { DiscoverPage } from '../community/DiscoverPage';

type View = 'chat' | 'settings';
type HubView = 'projects' | 'marketplace' | 'messages' | 'discover';

interface LayoutProps {
  geminiApiKey: string;
}

export const Layout: React.FC<LayoutProps> = ({ geminiApiKey }) => {
  const { user, supabase, isImpersonating, profile, isAdmin, signOut, stopImpersonating } = useAuth();
  const { addToast } = useToast();
  
  // Initialize with current location, but force a sync on mount to be safe
  const [pathname, setPathname] = useState(window.location.pathname);

  const [workspaceMode, setWorkspaceMode] = useLocalStorage<WorkspaceMode>('workspaceMode', 'autonomous');
  // PERSISTENCE: Track the last visited path to restore session after tab discard
  const [lastActivePath, setLastActivePath] = useLocalStorage<string | null>('lastActivePath', null);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<number[]>([]);
  const [currentSearchResultIndex, setCurrentSearchResultIndex] = useState(-1);

  const { width } = useWindowSize();
  const isMobile = width ? width < 768 : false;
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useLocalStorage('userSidebarCollapsed', false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const {
      allChats,
      setAllChats,
      activeChat,
      setActiveChat,
      messages,
      setMessages,
      isLoading,
      isCreatingChat,
      setIsCreatingChat,
      activeProject,
      handleUpdateChat,
      handleDeleteChat,
      handleSendMessage,
  } = useChat({ user, geminiApiKey, workspaceMode });

  // FORCE SYNC: Ensure state matches browser URL on mount. 
  // This fixes issues where tab restore might desync React state from actual URL.
  useEffect(() => {
      if (window.location.pathname !== pathname) {
          setPathname(window.location.pathname);
      }
  }, []);

  // Handle browser back/forward buttons
  useEffect(() => {
    const handlePopState = () => {
        if (window.location.pathname !== pathname) {
            setPathname(window.location.pathname);
        }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [pathname]);

  // PERSISTENCE EFFECT: Automatically save the current path whenever it changes.
  useEffect(() => {
      // Don't save the root path or explicit "new" chat paths as restoration targets
      // to avoid infinite redirect loops or creating unwanted empty chats.
      if (pathname !== '/' && !pathname.includes('/c/new')) {
          setLastActivePath(pathname);
      }
  }, [pathname, setLastActivePath]);

  const navigate = useCallback((path: string, replace: boolean = false) => {
    setPathname(path);
    setIsSidebarOpen(false); 

    try {
      if (replace) {
        window.history.replaceState({}, '', path);
      } else {
        if (window.location.pathname !== path) {
          window.history.pushState({}, '', path);
        }
      }
    } catch (e) {
    }
  }, []);

  const { view, hubView, chatId, isRoot } = useMemo(() => {
    const cleanPath = pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
    
    // Strict root check
    if (cleanPath === '/') return { view: 'root', isRoot: true };

    const parts = cleanPath.split('/').filter(Boolean);
    
    if (parts.length === 0) return { view: 'root', isRoot: true };

    if (parts[0] === 'settings') return { view: 'settings' };
    
    if (parts[0] === 'autonomous-chat') return { view: 'chat', chatId: 'new' };
    
    if (parts[0] === 'cocreator-hub') return { view: 'chat', hubView: 'projects' };
    if (parts[0] === 'projects') return { view: 'chat', hubView: 'projects' };
    if (parts[0] === 'marketplace') return { view: 'chat', hubView: 'marketplace' };
    if (parts[0] === 'messages') return { view: 'chat', hubView: 'messages' };
    if (parts[0] === 'discover') return { view: 'chat', hubView: 'discover' };
    
    if (parts[0] === 'c') return { view: 'chat', chatId: parts[1] };
    if (parts[0] === 'p' && parts.length >= 3 && parts[2] === 'c') {
      return { view: 'chat', chatId: parts[3] };
    }

    return { view: 'root', isRoot: true };
  }, [pathname]);

  useEffect(() => {
    if (isRoot) {
        // SESSION RESTORE: If we are at root (often due to a reload/tab discard), check if we have a saved path.
        if (lastActivePath && lastActivePath !== '/' && !lastActivePath.includes('new')) {
            // Validate that the restored path makes sense for the current mode
            navigate(lastActivePath, true);
            return;
        }

        if (workspaceMode === 'autonomous') {
            navigate('/autonomous-chat', true);
        } else {
            navigate('/projects', true);
        }
        return;
    }

    // Explicitly handle routing state based on URL, overriding previous state if needed
    if (chatId === 'new') {
        setWorkspaceMode('autonomous');
        setActiveChat(null);
    } else if (hubView) {
        setWorkspaceMode('cocreator');
        setActiveChat(null);
    } else if (chatId) {
      const chatToSelect = allChats.find(c => c.id === chatId);
      if (chatToSelect && chatToSelect.id !== activeChat?.id) {
        setActiveChat(chatToSelect);
        setWorkspaceMode(chatToSelect.project_id ? 'cocreator' : 'autonomous');
      }
    } else if (view === 'settings') {
      setActiveChat(null);
    }
  }, [view, hubView, chatId, isRoot, allChats, activeChat?.id, setActiveChat, setWorkspaceMode, navigate, workspaceMode, lastActivePath]);


  const isThinking = isLoading || isCreatingChat;
  const [loadingMessage, setLoadingMessage] = useState('Bubble is ready');
  const loadingTexts = useMemo(() => [
    "Thinking...", "Analyzing request...", "Consulting memory...", 
    "Formulating plan...", "Generating code...", "Adapting to updates..."
  ], []);

  useEffect(() => {
    let intervalId: number | undefined;
    if (isThinking) {
        let currentIndex = 0;
        setLoadingMessage(loadingTexts[currentIndex]);
        intervalId = window.setInterval(() => {
            currentIndex = (currentIndex + 1) % loadingTexts.length;
            setLoadingMessage(loadingTexts[currentIndex]);
        }, 2500);
    } else {
        setLoadingMessage('Bubble is ready');
    }
    return () => {
        if (intervalId) window.clearInterval(intervalId);
    };
  }, [isThinking, loadingTexts]);
  
  const handleLogoutAction = () => {
      // Clear persistence on logout
      setLastActivePath(null);
      if (isImpersonating) {
          stopImpersonating();
      } else {
          signOut();
      }
  };

  const autonomousChats = useMemo(() => {
    return allChats.filter(c => !c.project_id);
  }, [allChats]);
  
  const chatsForSidebar = useMemo(() => {
    if (workspaceMode === 'cocreator') {
        if (activeProject) {
            return allChats.filter(c => c.project_id === activeProject.id);
        } else {
            return autonomousChats;
        }
    }
    return autonomousChats;
  }, [allChats, workspaceMode, activeProject, autonomousChats]);
  
  const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);
  const closeSidebar = () => setIsSidebarOpen(false);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
        const sidebar = document.getElementById('left-sidebar');
        const hamburger = document.getElementById('hamburger-button');
        
        const isTransient = workspaceMode === 'cocreator' || isMobile;
        
        if (isTransient && isSidebarOpen && sidebar && !sidebar.contains(e.target as Node) && !hamburger?.contains(e.target as Node)) {
            closeSidebar();
        }
    };
    
    const handleEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && isSidebarOpen) closeSidebar();
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleEsc);
    }
  }, [isSidebarOpen, workspaceMode, isMobile]);

  const handleNewCoCreatorChat = async () => {
    if (!activeProject || !user || !supabase) return;
    setIsCreatingChat(true);
    try {
        const projectChats = allChats.filter(c => c.project_id === activeProject.id);
        const newChatName = `New Chat ${projectChats.length + 1}`;
        const newChat = await createDbChat(supabase, user.id, newChatName, 'build', activeProject.id);
        const newChatWithProjectData: ChatWithProjectData = { ...newChat, projects: activeProject };
        setAllChats(prev => [newChatWithProjectData, ...prev]);
        navigate(`/p/${activeProject.id}/c/${newChat.id}`);
    } catch (error) {
        console.error(error);
        addToast('Failed to create a new chat in this project.', 'error');
    } finally {
        setIsCreatingChat(false);
    }
  };

  const handleHamburgerClick = () => {
    const isPersistentNonMobile = workspaceMode === 'autonomous' && !isMobile;
    if (isPersistentNonMobile) {
        setIsSidebarCollapsed(!isSidebarCollapsed);
    } else {
        toggleSidebar();
    }
  };

  const handleSelectProjectFromHub = async (project: Project) => {
      if (!supabase) return;
      try {
          const projectChats = await getChatsForProject(supabase, project.id);
          
          const mostRecentChat = projectChats.sort((a, b) => 
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          )[0];
          
          if (mostRecentChat) {
              navigate(`/p/${project.id}/c/${mostRecentChat.id}`);
          } else {
              const newChat = await createDbChat(supabase, user!.id, `Main Chat`, 'build', project.id);
              const newChatWithProject: ChatWithProjectData = { ...newChat, projects: project };
              setAllChats(prev => [newChatWithProject, ...prev]);
              setActiveChat(newChatWithProject);
              navigate(`/p/${project.id}/c/${newChat.id}`);
          }
      } catch (e) {
          console.error("Error selecting project:", e);
          addToast("Failed to open project.", "error");
      }
  };

  const handleCreateCoCreatorProject = async (name: string, platform: ProjectPlatform, projectType: ProjectType): Promise<void> => {
    if (!user || !supabase) return;
    setIsCreatingChat(true);
    try {
        const newProject = await createProject(supabase, user.id, name, platform, projectType);
        addToast(`Created new project: ${name}!`, "success");
        
        const userChats = await getAllChatsForUser(supabase, user.id);
        setAllChats(userChats);
        
        await handleSelectProjectFromHub(newProject);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        addToast(`Failed to create project: ${errorMessage}`, "error");
        console.error("Error creating co-creator project:", error);
    } finally {
        setIsCreatingChat(false);
    }
  };

  const createProjectFromPrompt = async (prompt: string): Promise<void> => {
    if (!user || !supabase) return;
    setIsCreatingChat(true);
    try {
      const { name, description, project_type } = await generateProjectDetails(prompt, geminiApiKey!);
      const platform = project_type === 'roblox_game' ? 'Roblox Studio' : 'Web App';
      
      const newProject = await createProject(supabase, user.id, name, platform, project_type);
      newProject.description = description;
      await updateDbProject(supabase, newProject.id, { description });

      const newChat = await createDbChat(supabase, user.id, name, 'build', newProject.id);
      const newChatWithProject: ChatWithProjectData = { ...newChat, projects: newProject };

      addToast(`Created new project: ${name}!`, "success");
      setAllChats(prev => [newChatWithProject, ...prev]);
      
      const newPath = `/p/${newProject.id}/c/${newChat.id}`;
      navigate(newPath, true);
      
      setActiveChat(newChatWithProject);
      setWorkspaceMode('cocreator');
      
      const { projectUpdate } = await handleSendMessage(prompt, null, newChatWithProject);

      if (projectUpdate && newChatWithProject.project_id) {
          await updateDbProject(supabase, newChatWithProject.project_id, projectUpdate);
      }
      return;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        addToast(`Failed to create project: ${errorMessage}`, "error");
    } finally {
        setIsCreatingChat(false);
    }
  };

  const handleFirstMessage = async (prompt: string, files: File[] | null = null) => {
    if (!user || !supabase || !geminiApiKey) return;
    setIsCreatingChat(true);
    try {
      if (chatId === 'new' && workspaceMode === 'autonomous') {
        const newChat = await createDbChat(supabase, user.id, prompt, 'chat', null);
        const newChatWithProject: ChatWithProjectData = { ...newChat, projects: null };
        setAllChats(prev => [newChatWithProject, ...prev]);

        const newPath = `/c/${newChat.id}`;
        navigate(newPath, true);
        
        setActiveChat(newChatWithProject);
        
        await handleSendMessage(prompt, files, newChatWithProject);
      } else {
        const { intent } = await classifyUserIntent(prompt, geminiApiKey);
        if (intent === 'creative_request') {
          await createProjectFromPrompt(prompt);
        } else {
          addToast("To start a conversation, please switch to Autonomous Mode.", "info");
        }
      }
    } catch (error) {
       const errorMessage = error instanceof Error ? error.message : "Could not start your new chat.";
       addToast(errorMessage, "error");
       console.error("Error in handleFirstMessage:", error);
    } finally {
       setIsCreatingChat(false);
    }
  };
  
  const handleProjectFileUpdate = (path: string, content: string, isComplete: boolean) => {
      if (!activeProject) return;
      
      const updatedFiles = {
          ...(activeProject.files || {}),
          [path]: { content }
      };
      const updatedProject = { ...activeProject, files: updatedFiles };
      
      // Update the chat state with the new project data to trigger re-renders in the workspace
      setAllChats(prev => prev.map(c => {
          if (c.project_id === activeProject.id && c.projects) {
              return { ...c, projects: { ...c.projects, ...updatedProject } };
          }
          return c;
      }));
      
      // Also update activeChat if it's the current one
      if (activeChat?.project_id === activeProject.id) {
          setActiveChat(prev => prev ? { ...prev, projects: { ...prev.projects!, ...updatedProject } } : prev);
      }
  }

  const handleLocalSendMessage = async (text: string, files: File[] | null = null, chat?: ChatWithProjectData | null, modelOverride?: string) => {
      try {
          const { projectUpdate } = await handleSendMessage(
              text, 
              files, 
              chat, 
              modelOverride,
              handleProjectFileUpdate // Pass the streaming update callback
          );
          
          if (projectUpdate && activeProject) {
               await updateDbProject(supabase!, activeProject.id, projectUpdate);
          }
      } catch (e) {
          console.error("Error sending message:", e);
          addToast("Failed to send message", "error");
      }
  }
  
  const renderMainContent = () => {
    try {
        if (view === 'settings') {
            return <SettingsPage onBack={() => navigate('/projects')} />;
        }
        
        if (workspaceMode === 'cocreator') {
            if (!activeProject) {
                switch (hubView) {
                    case 'marketplace': return <MarketplacePage />;
                    case 'messages': return <MessagesPage onNavigate={navigate} />;
                    case 'discover': return <DiscoverPage />;
                    case 'projects':
                    default:
                        const projectsForHub = allChats
                            .map(c => c.projects)
                            .filter((p): p is Project => !!p)
                            .reduce((acc, current) => {
                                if (!acc.find(item => item.id === current.id)) {
                                    acc.push(current);
                                }
                                return acc;
                            }, [] as Project[]);
                        
                        return (
                            <ProjectsPage
                                profile={profile}
                                onSelectProject={handleSelectProjectFromHub}
                                projects={projectsForHub}
                                onCreateCoCreatorProject={handleCreateCoCreatorProject}
                                onCreateAutonomousProject={createProjectFromPrompt}
                            />
                        );
                }
            }
            
            return (
                <CoCreatorWorkspace
                    project={activeProject}
                    chat={activeChat}
                    geminiApiKey={geminiApiKey!}
                    messages={messages}
                    isLoadingHistory={isLoading}
                    isCreatingChat={isCreatingChat}
                    setMessages={setMessages}
                    onSendMessage={activeChat ? handleLocalSendMessage : handleFirstMessage}
                    onChatUpdate={(updates) => activeChat && handleUpdateChat(activeChat.id, updates)}
                    onActiveProjectUpdate={async (updates) => {
                        if (activeProject) {
                            try {
                                await updateDbProject(supabase!, activeProject.id, updates);
                            } catch (error) {
                                const message = error instanceof Error ? error.message : "An unknown error occurred";
                                addToast(`Error updating project: ${message}`, 'error');
                                console.error("Error in onActiveProjectUpdate:", error);
                            }
                        }
                    }}
                    searchQuery={searchQuery}
                    onSearchResultsChange={setSearchResults}
                    currentSearchResultMessageIndex={currentSearchResultIndex}
                    isAdmin={!!isAdmin}
                    workspaceMode={workspaceMode}
                    projectType={activeProject.project_type === 'website' ? 'website' : 'roblox_game'}
                    loadingMessage={loadingMessage}
                    streamingFile={undefined} // handled via chat updates
                />
            );
        }

        return (
            <ChatView
                key={activeChat?.id || 'autonomous-new-chat'}
                project={activeProject}
                chat={activeChat}
                geminiApiKey={geminiApiKey!}
                messages={messages}
                isLoadingHistory={isLoading}
                isCreatingChat={isCreatingChat}
                setMessages={setMessages}
                onSendMessage={activeChat ? handleLocalSendMessage : handleFirstMessage}
                onChatUpdate={(updates) => activeChat && handleUpdateChat(activeChat.id, updates)}
                onActiveProjectUpdate={null}
                searchQuery={searchQuery}
                onSearchResultsChange={setSearchResults}
                currentSearchResultMessageIndex={currentSearchResultIndex}
                isAdmin={!!isAdmin}
                workspaceMode={workspaceMode}
                loadingMessage={loadingMessage}
            />
        );
    } catch (error) {
        console.error("Render error in main content:", error);
        return <div className="p-8 text-center text-red-400">An error occurred while rendering the application content. Please refresh.</div>;
    }
  };
  
  const handleNewChatClick = () => {
    try {
        if (workspaceMode === 'cocreator' && activeProject) {
            handleNewCoCreatorChat();
        } else {
            navigate('/autonomous-chat');
        }
    } catch (e) {
        console.error("Error handling new chat click:", e);
    }
  };

  const handleSelectChatFromSidebar = (chat: ChatWithProjectData) => {
    const path = chat.project_id ? `/p/${chat.project_id}/c/${chat.id}` : `/c/${chat.id}`;
    navigate(path);
  };

  return (
    <div className="flex flex-col h-screen w-full font-sans text-text-primary bg-bg-primary">
      <StatusBar />
      <div className="flex flex-1 overflow-hidden">
        <LeftSidebar
          id="left-sidebar"
          allChats={chatsForSidebar}
          activeChatId={activeChat?.id}
          onSelectChat={handleSelectChatFromSidebar}
          onNewChatClick={handleNewChatClick}
          onUpdateChat={handleUpdateChat}
          onDeleteChat={handleDeleteChat}
          onSettingsClick={() => navigate('/settings')}
          onGoToHub={() => navigate('/cocreator-hub')}
          onSignOut={handleLogoutAction}
          profile={profile}
          isMobileOpen={isSidebarOpen}
          onMobileClose={closeSidebar}
          workspaceMode={workspaceMode}
          isAdmin={isAdmin}
          activeProject={activeProject}
          isPersistent={workspaceMode === 'autonomous' && !isMobile}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed(prev => !prev)}
        />
        <div className="flex-1 flex flex-col overflow-hidden">
          <TopBar
            onGoToHub={() => navigate('/cocreator-hub')}
            onAccountSettingsClick={() => navigate('/settings')}
            onProjectSettingsClick={() => { /* TODO */ }}
            onLogout={handleLogoutAction}
            activeProjectName={activeProject?.name ?? null}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            workspaceMode={workspaceMode}
            onWorkspaceModeChange={(mode) => setWorkspaceMode(mode)}
            isProjectView={!!activeProject}
            onHamburgerClick={handleHamburgerClick}
            showHamburger={isMobile || workspaceMode === 'cocreator' || (workspaceMode === 'autonomous' && isSidebarCollapsed)}
            isThinking={isThinking}
            onSwitchToAutonomous={() => navigate('/autonomous-chat')}
            onSwitchToCocreator={() => navigate('/cocreator-hub')}
            hubView={hubView as HubView}
            onHubViewChange={(newHubView) => navigate(`/${newHubView}`)}
            loadingMessage={loadingMessage}
            hamburgerId="hamburger-button"
          />
          <main className="flex-1 overflow-y-auto px-2 md:px-0">
            {renderMainContent()}
          </main>
        </div>
      </div>
    </div>
  );
};
