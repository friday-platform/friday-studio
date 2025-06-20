import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { NewWorkspaceConfig } from "../../../core/config-loader.ts";
import { useActiveFocus, useTabNavigation } from "../tabs.tsx";
import { SidebarWrapper } from "../SidebarWrapper.tsx";

interface AgentsTabProps {
  config: NewWorkspaceConfig;
}

interface AgentData {
  id: string;
  type: string;
  model?: string;
  purpose?: string;
  max_steps?: number;
  mcp_servers?: string[];
  prompts?: Record<string, string>;
  path?: string;
  url?: string;
  timeout_ms?: number;
}

export const AgentsTab = ({ config }: AgentsTabProps) => {
  const [scrollOffset, setScrollOffset] = useState(0);

  const agents = config.agents ? Object.entries(config.agents) : [];

  // Helper function to find jobs that use a specific agent
  const getJobsUsingAgent = (agentId: string) => {
    if (!config.jobs) return [];
    
    return Object.entries(config.jobs)
      .filter(([, job]) => {
        const jobData = job as any;
        return jobData.execution?.agents?.some((agent: any) => 
          (typeof agent === 'string' ? agent : agent.id) === agentId
        );
      })
      .map(([jobId, job]) => ({
        id: jobId,
        name: (job as any).name || jobId,
        description: (job as any).description
      }));
  };

  // Helper function to find signals that trigger jobs using a specific agent
  const getSignalsUsingAgent = (agentId: string) => {
    const jobsUsingAgent = getJobsUsingAgent(agentId);
    if (!config.signals || jobsUsingAgent.length === 0) return [];

    const signalIds = new Set<string>();
    
    // Find signals that trigger jobs using this agent
    jobsUsingAgent.forEach(job => {
      const jobData = config.jobs?.[job.id] as any;
      if (jobData?.triggers) {
        jobData.triggers.forEach((trigger: any) => {
          if (trigger.signal) {
            signalIds.add(trigger.signal);
          }
        });
      }
    });

    return Array.from(signalIds)
      .map(signalId => {
        const signal = config.signals?.[signalId] as any;
        return {
          id: signalId,
          description: signal?.description,
          provider: signal?.provider
        };
      })
      .filter(Boolean);
  };

  // Use active focus to switch between sidebar and main area
  const { activeArea } = useActiveFocus({
    areas: ["sidebar", "main"],
    initialArea: 0,
  });

  const isSidebarActive = activeArea === 0;
  const isMainActive = activeArea === 1;

  // Use tab navigation for agents with arrow key support when sidebar is active
  const { activeTab: selectedAgentIndex } = useTabNavigation({
    tabCount: agents.length,
    initialTab: 0,
    useArrowKeys: true,
    isActive: isSidebarActive,
  });

  const selectedAgent = agents.length > 0 ? agents[selectedAgentIndex][0] : null;
  const selectedAgentData = selectedAgent && config.agents
    ? config.agents[selectedAgent] as AgentData
    : null;

  // Handle keyboard navigation for scrolling when main area is active
  useInput((inputChar, key) => {
    if (isMainActive) {
      const scrollAmount = key.shift ? 10 : 1;

      if (key.upArrow || inputChar === "k") {
        setScrollOffset((prev) => Math.min(0, prev + scrollAmount));
      } else if (key.downArrow || inputChar === "j") {
        setScrollOffset((prev) => prev - scrollAmount);
      }

      // Handle vim keys with shift modifier for fast scrolling
      if (inputChar === "K") {
        setScrollOffset((prev) => Math.min(0, prev + 10));
      } else if (inputChar === "J") {
        setScrollOffset((prev) => prev - 10);
      }
    }
  });

  if (!config.agents || agents.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text dimColor>No agents configured</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" height="100%" width="100%">
      {/* Sidebar */}
      <SidebarWrapper isActive={isSidebarActive}>
        {agents.map(([agentId], index) => (
          <Box key={agentId}>
            <Text
              bold={index === selectedAgentIndex}
              dimColor={index !== selectedAgentIndex}
            >
              {index === selectedAgentIndex ? "❯ " : "  "}
              {agentId}
            </Text>
          </Box>
        ))}
      </SidebarWrapper>

      {/* Main Area */}
      <Box
        flexDirection="column"
        flexGrow={1}
        paddingX={isMainActive ? 2 : 3}
        paddingY={isMainActive ? 1 : 2}
        overflow="hidden"
        borderStyle={isMainActive ? "round" : undefined}
        borderColor="gray"
        borderDimColor
      >
        {selectedAgentData
          ? (
            <Box
              flexDirection="column"
              marginTop={scrollOffset}
              flexGrow={1}
              flexShrink={0}
            >
              {/* Agent Header */}
              <Box marginBottom={2}>
                <Text bold>{selectedAgent}</Text>
              </Box>

              {/* Basic Information */}
              <Box flexDirection="column" marginBottom={2}>
                <Box marginBottom={1}>
                  <Text dimColor>Type:</Text>
                  <Text>{selectedAgentData.type}</Text>
                </Box>
                {selectedAgentData.model && (
                  <Box marginBottom={1}>
                    <Text dimColor>Model:</Text>
                    <Text>{selectedAgentData.model}</Text>
                  </Box>
                )}
                {selectedAgentData.purpose && (
                  <Box marginBottom={1}>
                    <Text dimColor>Purpose:</Text>
                    <Text>{selectedAgentData.purpose}</Text>
                  </Box>
                )}
                {selectedAgentData.max_steps && (
                  <Box marginBottom={1}>
                    <Text dimColor>Max Steps:</Text>
                    <Text>{selectedAgentData.max_steps}</Text>
                  </Box>
                )}
              </Box>

              {/* Type-Specific Configuration */}
              {selectedAgentData.type === "llm" && (
                <Box flexDirection="column" marginBottom={2}>
                  <Box marginBottom={1}>
                    <Text bold>LLM Configuration:</Text>
                  </Box>
                  {selectedAgentData.mcp_servers && selectedAgentData.mcp_servers.length > 0 && (
                    <Box flexDirection="column" marginBottom={1}>
                      <Text dimColor>MCP Servers:</Text>
                      {selectedAgentData.mcp_servers.map((server) => (
                        <Box key={server} marginLeft={2}>
                          <Text dimColor>•</Text>
                          <Text>{server}</Text>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>
              )}

              {selectedAgentData.type === "tempest" && (
                <Box flexDirection="column" marginBottom={2}>
                  <Box marginBottom={1}>
                    <Text bold>Tempest Configuration:</Text>
                  </Box>
                  {selectedAgentData.path && (
                    <Box marginBottom={1}>
                      <Text dimColor>Path:</Text>
                      <Text>{selectedAgentData.path}</Text>
                    </Box>
                  )}
                </Box>
              )}

              {selectedAgentData.type === "remote" && (
                <Box flexDirection="column" marginBottom={2}>
                  <Box marginBottom={1}>
                    <Text bold>Remote Configuration:</Text>
                  </Box>
                  {selectedAgentData.url && (
                    <Box marginBottom={1}>
                      <Text dimColor>URL:</Text>
                      <Text>{selectedAgentData.url}</Text>
                    </Box>
                  )}
                  {selectedAgentData.timeout_ms && (
                    <Box marginBottom={1}>
                      <Text dimColor>Timeout:</Text>
                      <Text>{selectedAgentData.timeout_ms}ms</Text>
                    </Box>
                  )}
                </Box>
              )}

              {/* Prompts Section */}
              {selectedAgentData.prompts && Object.keys(selectedAgentData.prompts).length > 0 && (
                <Box flexDirection="column" marginBottom={2}>
                  <Box marginBottom={1}>
                    <Text bold>Prompts:</Text>
                  </Box>
                  {Object.entries(selectedAgentData.prompts).map(([promptType, prompt]) => (
                    <Box key={promptType} flexDirection="column" marginBottom={2}>
                      <Box marginBottom={1}>
                        <Text dimColor>{promptType}:</Text>
                      </Box>
                      <Box marginLeft={2} flexDirection="column">
                        {prompt.split('\n').slice(0, 10).map((line, index) => (
                          <Text key={index} dimColor>{line}</Text>
                        ))}
                        {prompt.split('\n').length > 10 && (
                          <Text dimColor>... ({prompt.split('\n').length - 10} more lines)</Text>
                        )}
                      </Box>
                    </Box>
                  ))}
                </Box>
              )}

              {/* Usage Section */}
              {(() => {
                const jobsUsingAgent = getJobsUsingAgent(selectedAgent!);
                const signalsUsingAgent = getSignalsUsingAgent(selectedAgent!);
                
                if (jobsUsingAgent.length > 0 || signalsUsingAgent.length > 0) {
                  return (
                    <Box flexDirection="column" marginBottom={2}>
                      <Box marginBottom={1}>
                        <Text bold>Usage:</Text>
                      </Box>
                      
                      {jobsUsingAgent.length > 0 && (
                        <Box flexDirection="column" marginBottom={2}>
                          <Box marginBottom={1}>
                            <Text dimColor>Used in Jobs:</Text>
                          </Box>
                          {jobsUsingAgent.map((job) => (
                            <Box key={job.id} marginLeft={2} marginBottom={1}>
                              <Box flexDirection="column">
                                <Box>
                                  <Text dimColor>•</Text>
                                  <Text bold>{job.name}</Text>
                                </Box>
                                {job.description && (
                                  <Box marginLeft={2}>
                                    <Text dimColor>{job.description}</Text>
                                  </Box>
                                )}
                              </Box>
                            </Box>
                          ))}
                        </Box>
                      )}
                      
                      {signalsUsingAgent.length > 0 && (
                        <Box flexDirection="column" marginBottom={2}>
                          <Box marginBottom={1}>
                            <Text dimColor>Triggered by Signals:</Text>
                          </Box>
                          {signalsUsingAgent.map((signal) => (
                            <Box key={signal.id} marginLeft={2} marginBottom={1}>
                              <Box flexDirection="column">
                                <Box>
                                  <Text dimColor>•</Text>
                                  <Text bold>{signal.id}</Text>
                                  <Text dimColor>({signal.provider})</Text>
                                </Box>
                                {signal.description && (
                                  <Box marginLeft={2}>
                                    <Text dimColor>{signal.description}</Text>
                                  </Box>
                                )}
                              </Box>
                            </Box>
                          ))}
                        </Box>
                      )}
                    </Box>
                  );
                } else {
                  return (
                    <Box flexDirection="column" marginBottom={2}>
                      <Box marginBottom={1}>
                        <Text bold>Usage:</Text>
                      </Box>
                      <Box marginLeft={2}>
                        <Text dimColor>This agent is not currently used in any jobs or signals</Text>
                      </Box>
                    </Box>
                  );
                }
              })()}

              {/* Raw Configuration (for debugging) */}
              <Box flexDirection="column" marginTop={2}>
                <Box marginBottom={1}>
                  <Text bold>Configuration:</Text>
                </Box>
                <Box marginLeft={2}>
                  <Text dimColor>
                    {JSON.stringify(
                      {
                        ...selectedAgentData,
                        prompts: selectedAgentData.prompts 
                          ? Object.keys(selectedAgentData.prompts).reduce((acc, key) => ({
                              ...acc,
                              [key]: `${selectedAgentData.prompts![key].substring(0, 50)}...`
                            }), {})
                          : undefined
                      },
                      null,
                      2
                    )}
                  </Text>
                </Box>
              </Box>
            </Box>
          )
          : (
            <Box
              flexDirection="column"
              alignItems="center"
              justifyContent="center"
              height="100%"
            >
              <Text dimColor>Select an agent to view details</Text>
            </Box>
          )}
      </Box>
    </Box>
  );
};
