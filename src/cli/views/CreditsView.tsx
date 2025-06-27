import { Box, Text, useInput } from "ink";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";

interface CreditsViewProps {
  onExit: () => void;
}

export default function CreditsView({ onExit }: CreditsViewProps) {
  const symbol = "⋅";
  const dimensions = useResponsiveDimensions({ minHeight: 24 });
  useInput((_, key) => {
    if (key.return || key.escape) {
      onExit();
      return;
    }
  });

  return (
    <Box
      flexDirection="row"
      justifyContent="center"
      alignItems="center"
      gap={3}
      padding={1}
      height={dimensions.height - 7}
      width="100%"
    >
      <Text color="blue">
        {`
                ${symbol}${symbol}                 
          ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}             
           ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}            
             ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}            
             ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}           
            ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}            
          ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}             
                ${symbol}${symbol}     ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}  
                ${symbol}${symbol}   ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}     
    ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}     
     ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol} ${symbol}${symbol}${symbol}${symbol} ${symbol}${symbol}${symbol}${symbol} ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}       
      ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}        
         ${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}${symbol}`}
      </Text>

      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        <Text bold>Thank you to our contributors:</Text>

        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text dimColor>Ken Kouot</Text>
          <Text dimColor>Łukasz Jagiełło</Text>
          <Text dimColor>Eric Skram</Text>
          <Text dimColor>Michał Gryko</Text>
          <Text dimColor>Sara Ryfczyńska</Text>
          <Text dimColor>Yena Oh</Text>
          <Text dimColor>David Woolf</Text>
        </Box>

        <Box marginTop={2}>
          <Text bold dimColor>
            Press enter to continue...
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
