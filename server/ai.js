const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getSystemPrompt, getGoal } = require("./npc-system-prompt");

class AIController {
    constructor(apiKey, nationality = 'english') {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        this.nationality = nationality;
    }

    getSystemPrompt(player, gameState) {
        return getSystemPrompt(player, gameState);
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

    async generateChat(player, gameState, isAddressed = false) {
        console.log(`[AI] Generating Chat for ${player.name}...`);

        // Get last 10 chat messages
        const recentChats = gameState.gameChat.slice(-10).map(c => `${c.senderName}: ${c.message}`).join("\n");

        // Language instruction based on nationality
        const languageInstruction = this.nationality === 'lithuanian'
            ? 'IMPORTANT: You MUST respond in Lithuanian language.'
            : 'Respond in English.';

        const prompt = this.getSystemPrompt(player, gameState) +
            `\nIt is currently DAY DISCUSSION. 
      
      Recent Chat History:
      ${recentChats || "(No chat history yet)"}
      
      ${isAddressed ? "You have been DIRECTLY ADDRESSED. You MUST respond clearly." : "You have NOT been directly addressed. Only respond if you have CRITICAL information (like night results) or a strong strategic reason. If not, respond with 'SILENCE'."}
      
      Respond with a short, in-character chat message.
      - React to what others are saying in the Recent Chat History.
      - Defend yourself if accused.
      - Accuse others if you have suspicion.
      - If you have nothing relevant to say or want to remain silent, respond with just "SILENCE".
      - Keep it under 100 characters.
      ${languageInstruction}`;

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
        console.log(`[AI] Generating NPC Profile (nationality: ${this.nationality})...`);
        const forbiddenNames = existingNames.map(n => n.trim()).join(", ");

        // Name instructions based on nationality
        const nameInstruction = this.nationality === 'lithuanian'
            ? 'Generate a Lithuanian first name (e.g., Vytautas, Giedrius, Rasa, Eglė, Jonas, Dalia, Mindaugas, Aušra). The name should be authentic Lithuanian.'
            : 'Generate an English/American first name (e.g., James, Sarah, Michael, Emily, David, Jessica). The name should be a common English name.';

        const prompt = `Generate a unique profile for a player in a social deduction game (like Mafia/Werewolf).
        
        Existing names you MUST NOT USE: ${forbiddenNames}
        
        ${nameInstruction}
        
        The personality should be **strategic and game-focused**.
        The talking style MUST be **clear, concise, and direct**.
        Do NOT generate "stuttering", "shouting", "cryptic", or "whispering" styles.
        The goal is to be easily understood by other players.

        Include a short **background story** (1 sentence) that explains who they are (e.g., "A focused detective," "A calm doctor").

        Respond with a JSON object: 
        { 
            "name": "A unique realistic first name only. Must NOT be in the excluded list.", 
            "gender": "male or female - based on the generated name",
            "personality": "A brief description of their personality (e.g., 'Analytical and direct', 'Calm and persuasive')",
            "talkingStyle": "A brief description of how they talk (e.g., 'Clear and to the point', 'Polite but firm')",
            "background": "A short 1-sentence background story."
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

}

module.exports = AIController;

