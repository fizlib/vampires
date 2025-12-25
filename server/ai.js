const { GoogleGenerativeAI } = require("@google/generative-ai");

class AIController {
    constructor(apiKey) {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    }

    async generateNightAction(player, gameState) {
        console.log(`[AI] Generating Night Action for ${player.name} (${player.role})...`);
        const prompt = this.getSystemPrompt(player, gameState) +
            `\nIt is currently NIGHT. You need to perform your night action.
      Available actions based on your role (${player.role}):
      - Investigator: INVESTIGATE <target_name>
      - Lookout: LOOKOUT <target_name>
      - Doctor: HEAL <target_name>
      - Jailor: JAIL <target_name> (or EXECUTE if you have a prisoner)
      - Vampire: BITE <target_name> (only if turn is available, otherwise coordinate)
      - Vampire Framer: FRAME <target_name> (and BITE if available)
      - Citizen/Jester: NO_ACTION
      
      Respond with a JSON object: { "action": "ACTION_TYPE", "targetName": "PlayerName" }
      If no action is needed or possible, return { "action": "NONE", "targetName": null }.
      Do not include markdown formatting, just raw JSON.`;

        try {
            const result = await this.model.generateContent(prompt);
            const text = result.response.text();
            const decision = this.parseJSON(text);
            console.log(`[AI] Night Action Decision for ${player.name}:`, JSON.stringify(decision));
            return decision;
        } catch (error) {
            console.error("AI Night Action Error:", error);
            return { action: "NONE", targetName: null };
        }
    }

    async generateDayVote(player, gameState) {
        console.log(`[AI] Generating Day Vote for ${player.name}...`);
        const prompt = this.getSystemPrompt(player, gameState) +
            `\nIt is currently DAY VOTING. You need to decide who to vote for lynching.
      Respond with a JSON object: { "vote": "PlayerName" } or { "vote": null } if you abstain.
      Do not include markdown formatting, just raw JSON.`;

        try {
            const result = await this.model.generateContent(prompt);
            const text = result.response.text();
            const decision = this.parseJSON(text);
            console.log(`[AI] Vote Decision for ${player.name}:`, JSON.stringify(decision));
            return decision;
        } catch (error) {
            console.error("AI Day Vote Error:", error);
            return { vote: null };
        }
    }

    async generateVoteIntent(player, gameState) {
        console.log(`[AI] Generating Vote Intent for ${player.name}...`);
        const prompt = this.getSystemPrompt(player, gameState) +
            `\nIt is currently DAY DISCUSSION. You are listening to the conversation.
      Who are you most suspicious of right now?
      Respond with a JSON object: { "vote": "PlayerName" } or { "vote": null } if unsure.
      Do not include markdown formatting, just raw JSON.`;

        try {
            const result = await this.model.generateContent(prompt);
            const text = result.response.text();
            const decision = this.parseJSON(text);
            console.log(`[AI] Vote Intent for ${player.name}:`, JSON.stringify(decision));
            return decision;
        } catch (error) {
            console.error("AI Vote Intent Error:", error);
            return { vote: null };
        }
    }

    async generateUpdatedVote(player, gameState, currentVoteName) {
        console.log(`[AI] Re-evaluating Vote for ${player.name} (Currently voting: ${currentVoteName})...`);
        const prompt = this.getSystemPrompt(player, gameState) +
            `\nIt is currently DAY VOTING.
      You have currently voted for: ${currentVoteName || "No one"}.
      Considering the current vote counts and situation, do you want to CHANGE your vote?
      
      Respond with a JSON object: { "vote": "NewTargetName" }
      - If you want to keep your vote, return the same name: { "vote": "${currentVoteName}" }.
      - If you want to change, return the new name.
      - If you want to unvote/abstain, return { "vote": null }.
      
      Do not include markdown formatting, just raw JSON.`;

        try {
            const result = await this.model.generateContent(prompt);
            const text = result.response.text();
            const decision = this.parseJSON(text);
            console.log(`[AI] Updated Vote Decision for ${player.name}:`, JSON.stringify(decision));
            return decision;
        } catch (error) {
            console.error("AI Updated Vote Error:", error);
            return { vote: currentVoteName }; // Default to keeping current vote
        }
    }

    async generateChat(player, gameState) {
        console.log(`[AI] Generating Chat for ${player.name}...`);

        // Get last 10 chat messages
        const recentChats = gameState.gameChat.slice(-10).map(c => `${c.senderName}: ${c.message}`).join("\n");

        const prompt = this.getSystemPrompt(player, gameState) +
            `\nIt is currently DAY DISCUSSION. 
      
      Recent Chat History:
      ${recentChats || "(No chat history yet)"}
      
      Respond with a short, in-character chat message.
      - React to what others are saying in the Recent Chat History.
      - Defend yourself if accused.
      - Accuse others if you have suspicion.
      - If you have nothing relevant to say or want to remain silent, respond with just "SILENCE".
      - Keep it under 100 characters.`;

        try {
            const result = await this.model.generateContent(prompt);
            const msg = result.response.text().trim();
            console.log(`[AI] Chat Message from ${player.name}:`, msg);
            return msg === "SILENCE" ? null : msg;
        } catch (error) {
            console.error("AI Chat Error:", error);
            return null;
        }
    }

    parseJSON(text) {
        try {
            // Remove potential markdown code blocks
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanText);
        } catch (e) {
            console.error("Failed to parse JSON:", text);
            return {};
        }
    }

    async generateNPCProfile(existingNames = []) {
        console.log("[AI] Generating NPC Profile...");
        const forbiddenNames = existingNames.map(n => n.replace('[NPC] ', '').trim()).join(", ");

        const prompt = `Generate a unique profile for a player in a social deduction game (like Mafia/Werewolf).
        
        Existing names you MUST NOT USE: ${forbiddenNames}
        
        Respond with a JSON object: 
        { 
            "name": "A unique realistic first name only (can be English or Lithuanian). Must NOT be in the excluded list.", 
            "personality": "A brief description of their personality (e.g., paranoid, aggressive, analytical, quiet)",
            "talkingStyle": "A brief description of how they talk (e.g., uses lots of slang, formal, stutters, shouts, speaks in riddles)"
        }
        Do not include markdown formatting, just raw JSON.`;

        try {
            const result = await this.model.generateContent(prompt);
            const text = result.response.text();
            const profile = this.parseJSON(text);
            console.log("[AI] Generated Profile:", JSON.stringify(profile));
            // Validate minimal requirements
            if (profile.name && profile.personality && profile.talkingStyle) {
                return profile;
            }
            throw new Error("Invalid profile format");
        } catch (error) {
            console.error("AI Profile Generation Error:", error);
            return null;
        }
    }

    getSystemPrompt(player, gameState) {
        const livingPlayers = gameState.players.filter(p => p.alive).map(p => p.name).join(", ");
        const recentLogs = gameState.logs.slice(-5).join("\n");

        let personalityContext = "";
        if (player.personality && player.talkingStyle) {
            personalityContext = `
    Your personality: ${player.personality}
    Your talking style: ${player.talkingStyle}
    Adopt this persona in your chat messages and voting patterns.`;
        }

        return `You are playing a game of social deduction (like Mafia/Werewolf).
    Your name is ${player.name}.
    Your role is ${player.role}.
    Your alignment is ${player.alignment}.
    Your objective: ${this.getGoal(player.role)}
    ${personalityContext}
    
    Living players: ${livingPlayers}
    Recent events:
    ${recentLogs}
    
    Act according to your role. Be strategic.`;
    }

    getGoal(role) {
        const goals = {
            'Investigator': 'Find the vampires.',
            'Lookout': 'Watch for suspicious visits.',
            'Doctor': 'Save innocents from vampires.',
            'Jailor': 'Jail and execute the guilty.',
            'Citizen': 'Vote out the vampires.',
            'Vampire': 'Kill all non-vampires. Coordinate with other vampires.',
            'Vampire Framer': 'Frame innocents and help vampires kill.',
            'Jester': 'Get yourself lynched by vote.'
        };
        return goals[role] || 'Survive.';
    }
}

module.exports = AIController;
