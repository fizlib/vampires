const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getSystemPrompt, getGoal, getProfileGenerationPrompt, getJailInterrogationPrompt } = require("./npc-system-prompt");

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

        // Determine if vampires can bite tonight (even nights only)
        const round = gameState.round || 1;
        const isEvenNight = round % 2 === 0;
        const canVampiresBite = isEvenNight;

        // Build Doctor-specific reasoning context
        let doctorContext = '';
        if (player.role === 'Doctor') {
            const recentChats = gameState.gameChat?.slice(-15).map(c => `${c.senderName}: ${c.message}`).join("\n") || "(No chat history)";

            if (!canVampiresBite) {
                doctorContext = `
      
      ⚠️ CRITICAL DOCTOR STRATEGY FOR NIGHT ${round} (ODD NIGHT):
      Vampires CANNOT bite on odd nights (Night 1, 3, 5...). This means NO ONE can be turned into a vampire tonight.
      
      STRONG RECOMMENDATION: Save your heal for an even night when vampires CAN actually bite!
      You only have 3 heals total - don't waste them when there's no threat.
      
      Return { "action": "NONE", "targetName": null } to save your heal for when it matters.
      
      Only heal tonight if you have a very specific reason (which is rare on odd nights).`;
            } else {
                doctorContext = `
      
      STRATEGIC HEAL TARGET SELECTION (EVEN NIGHT - VAMPIRES CAN BITE!):
      This is an even night - vampires CAN bite tonight! Your heal could save someone's life.
      
      CHAT HISTORY - Analyze who might be targeted:
      ${recentChats}
      
      PRIORITY TARGETS TO HEAL:
      - Players who have claimed important roles (Investigator, Lookout, Jailor)
      - Players who have called out vampires or are leading the town
      - Players who seem to be vampire targets based on chat
      
      TARGETS LESS LIKELY TO NEED HEALING:
      - Players who are already suspicious (vampires might let town lynch them)
      - Silent players who aren't drawing attention
      - Players who might be protected by Jailor
      
      Remember: You have limited heals. Make them count!`;
            }
        }

        // Build vampire-specific reasoning context
        let vampireContext = '';
        if (player.alignment === 'evil' && (player.role === 'Vampire' || player.role === 'Vampire Framer')) {
            const recentChats = gameState.gameChat?.slice(-15).map(c => `${c.senderName}: ${c.message}`).join("\n") || "(No chat history)";
            vampireContext = `
      
      STRATEGIC BITE TARGET SELECTION:
      Before choosing who to bite, carefully analyze ALL information:
      
      1. CHAT HISTORY - Who has claimed what role? Who is suspicious of whom?
      ${recentChats}
      
      2. PRIORITY TARGETS TO ELIMINATE/TURN:
         - Investigators who might expose you
         - Lookouts who might catch you visiting
         - Players who are suspicious of vampires
         - Confirmed town roles that are dangerous to vampires
      
      3. TARGETS TO AVOID:
         - Players likely to be protected by Doctor (confirmed important roles)
         - Players who might be jailed
         - Other vampires (you can't turn them)
      
      4. CONSIDER:
         - Who has been most vocal against you or your team?
         - Who has shared investigation results?
         - Who seems to be leading the town?
         - Who is flying under the radar but could be dangerous?`;
        }

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
      ${doctorContext}
      ${vampireContext}
      
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

        // Get chat history for context
        const recentChats = gameState.gameChat?.slice(-15).map(c => `${c.senderName}: ${c.message}`).join("\n") || "(No chat history)";

        const prompt = this.getSystemPrompt(player, gameState) +
            `\nIt is currently DAY VOTING. You need to decide who to vote for lynching.
      
      BEFORE VOTING, carefully consider ALL available information:
      
      1. CHAT HISTORY - What has been said? Who claimed what role? Who accused whom?
      ${recentChats}
      
      2. ANALYZE EACH LIVING PLAYER:
         - What role did they claim (if any)?
         - Were they accused by anyone? Did they defend themselves convincingly?
         - Did they share any night action results? Were those results consistent?
         - Are there contradictions in what they said vs what happened?
         - Have they been acting suspicious or too quiet?
      
      3. YOUR OWN KNOWLEDGE:
         - Your night action results (if any)
         - Your suspicions based on behavior
         - Your alignment and goals
      
      4. STRATEGIC CONSIDERATIONS:
         ${player.alignment === 'evil' ?
                '- You are EVIL. Vote for town members, not your vampire allies. Try to blend in with town voting patterns.' :
                '- You are GOOD. Vote for the most suspicious player to eliminate vampires.'}
         ${player.role === 'Jester' ? '- You are Jester! Try to get yourself lynched by acting slightly suspicious.' : ''}
      
      Based on ALL this information, choose who to vote for.
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

    async generateUpdatedVote(player, gameState, currentVoteName) {
        console.log(`[AI] Re-evaluating Vote for ${player.name} (Currently voting: ${currentVoteName})...`);

        // Get chat history for context
        const recentChats = gameState.gameChat?.slice(-15).map(c => `${c.senderName}: ${c.message}`).join("\n") || "(No chat history)";

        const prompt = this.getSystemPrompt(player, gameState) +
            `\nIt is currently DAY VOTING.
      You have currently voted for: ${currentVoteName || "No one"}.
      
      RE-EVALUATE your vote based on NEW information since you last voted:
      
      RECENT CHAT HISTORY:
      ${recentChats}
      
      CONSIDER:
      - Has anyone said something that clears or incriminates your current target?
      - Has new evidence emerged against someone else?
      - Is the vote close? Should you change to secure a lynch on a suspicious player?
      - Has your current target defended themselves convincingly?
      - Are people bandwagoning on someone who might be innocent?
      ${player.alignment === 'evil' ?
                '- As evil, try to vote with town to blend in, or push votes away from vampires.' :
                '- As town, focus on voting out the most suspicious player.'}
      
      Based on the current situation, do you want to CHANGE your vote?
      
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

    async generateChat(player, gameState, isAddressed = false, isProactive = false) {
        console.log(`[AI] Generating Chat for ${player.name}...`);

        // Get last 10 chat messages
        const recentChats = gameState.gameChat.slice(-10).map(c => `${c.senderName}: ${c.message}`).join("\n");

        // Language instruction based on nationality
        const languageInstruction = this.nationality === 'lithuanian'
            ? 'IMPORTANT: You MUST respond in Lithuanian language. EXCEPTION: Role names must ALWAYS be written in English (Investigator, Lookout, Doctor, Jailor, Citizen, Vampire, Vampire Framer, Jester). For example: "Aš esu Investigator" NOT "Aš esu Tyrėjas".'
            : 'Respond in English.';

        // Build appropriate speaking instruction based on context
        let speakingInstruction;
        if (isAddressed) {
            speakingInstruction = "You have been DIRECTLY ADDRESSED. You MUST respond clearly to what was said to you.";
        } else if (isProactive) {
            speakingInstruction = `This is your chance to share information or contribute to the discussion.
      
      SPEAK if you have ANY of these:
      - Night action results you haven't shared yet (e.g., investigation results, who you saw visiting someone)
      - A suspicion or observation about another player's behavior
      - A defense if someone has accused you or seems suspicious of you
      - Support or agreement with someone's claim
      - A question that could help the town
      
      Only respond 'SILENCE' if you truly have NOTHING useful to add right now.`;
        } else {
            speakingInstruction = `Consider responding if:
      - You have relevant information to share (night results, suspicions)
      - Someone made a claim you want to react to
      - The discussion is relevant to your investigation or observations
      
      Be thoughtful - don't spam, but don't stay completely quiet if you have something useful to say.
      Respond 'SILENCE' only if you have nothing meaningful to contribute right now.`;
        }

        const prompt = this.getSystemPrompt(player, gameState) +
            `\nIt is currently DAY DISCUSSION. Round: ${gameState.round}
      
      Recent Chat History:
      ${recentChats || "(No chat history yet)"}
      
      ${speakingInstruction}
      
      Respond with a short, in-character chat message.
      - Share your night action results if you have any and haven't shared them
      - React to accusations, claims, or discussions in chat
      - Defend yourself if accused
      - Accuse others if you have suspicion
      - Support or question others' claims
      - If you truly have nothing relevant to add, respond with just "SILENCE"
      - Keep it under 100 characters
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

    /**
     * Generate a response for a jailed NPC (prisoner responding to jailor)
     */
    async generateJailResponse(player, gameState, jailChat, jailorName) {
        console.log(`[AI] Generating Jail Response for ${player.name}...`);

        // Language instruction based on nationality
        const languageInstruction = this.nationality === 'lithuanian'
            ? 'IMPORTANT: You MUST respond in Lithuanian language. EXCEPTION: Role names must ALWAYS be written in English (Investigator, Lookout, Doctor, Jailor, Citizen, Vampire, Vampire Framer, Jester).'
            : 'Respond in English.';

        const prompt = getJailInterrogationPrompt(player, gameState, jailChat, false, jailorName) +
            `\n\nRespond to the Jailor. Be convincing. Keep it under 100 characters.
            Respond with just your message, no JSON formatting.
            ${languageInstruction}`;

        try {
            const result = await this.model.generateContent(prompt);
            const msg = result.response.text().trim();
            console.log(`[AI] Jail Response from ${player.name}:`, msg);
            return msg;
        } catch (error) {
            console.error("AI Jail Response Error:", error);
            return "I'm innocent, I swear!";
        }
    }

    /**
     * Generate an interrogation message for an NPC Jailor
     */
    async generateJailorMessage(player, gameState, jailChat, prisonerName) {
        console.log(`[AI] Generating Jailor Interrogation for ${player.name}...`);

        // Language instruction based on nationality
        const languageInstruction = this.nationality === 'lithuanian'
            ? 'IMPORTANT: You MUST respond in Lithuanian language. EXCEPTION: Role names must ALWAYS be written in English (Investigator, Lookout, Doctor, Jailor, Citizen, Vampire, Vampire Framer, Jester).'
            : 'Respond in English.';

        const prompt = getJailInterrogationPrompt(player, gameState, jailChat, true, prisonerName) +
            `\n\nAsk the prisoner a question or make a statement to interrogate them.
            Keep it under 100 characters. Respond with just your message, no JSON formatting.
            ${languageInstruction}`;

        try {
            const result = await this.model.generateContent(prompt);
            const msg = result.response.text().trim();
            console.log(`[AI] Jailor Message from ${player.name}:`, msg);
            return msg;
        } catch (error) {
            console.error("AI Jailor Message Error:", error);
            return "What is your role?";
        }
    }

    /**
     * Generate an execution decision for an NPC Jailor
     */
    async generateExecuteDecision(player, gameState, jailChat, prisonerName) {
        console.log(`[AI] Generating Execute Decision for ${player.name}...`);

        // Language instruction based on nationality (for the reason field)
        const languageInstruction = this.nationality === 'lithuanian'
            ? 'IMPORTANT: The "reason" field in your JSON response MUST be in Lithuanian language. Role names must still be in English.'
            : '';

        const prompt = getJailInterrogationPrompt(player, gameState, jailChat, true, prisonerName) +
            `\n\nBased on the interrogation, decide whether to EXECUTE the prisoner or SPARE them.
            
            Consider:
            - Do their claims match what you know from the game?
            - Are they being evasive or contradictory?
            - What role do they claim? Does it make sense?
            - Would executing them help the town or hurt it?
            - REMEMBER: Executing an innocent will KILL YOU!
            
            Respond with a JSON object: { "execute": true/false, "reason": "brief reason" }
            Do not include markdown formatting, just raw JSON.
            ${languageInstruction}`;

        try {
            const result = await this.model.generateContent(prompt);
            const text = result.response.text();
            const decision = this.parseJSON(text);
            console.log(`[AI] Execute Decision from ${player.name}:`, JSON.stringify(decision));
            return decision;
        } catch (error) {
            console.error("AI Execute Decision Error:", error);
            return { execute: false, reason: "Uncertain - better safe than sorry" };
        }
    }

    parseJSON(text) {
        try {
            // Remove potential markdown code blocks
            let cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();

            // First, try direct parsing
            try {
                return JSON.parse(cleanText);
            } catch (directError) {
                // If direct parsing fails, try to extract JSON from the text
            }

            // Look for JSON object pattern in the text
            const jsonMatch = cleanText.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
                try {
                    return JSON.parse(jsonMatch[0]);
                } catch (matchError) {
                    // Try to find the last JSON object (in case there are multiple)
                    const allMatches = cleanText.match(/\{[^{}]*\}/g);
                    if (allMatches) {
                        for (let i = allMatches.length - 1; i >= 0; i--) {
                            try {
                                return JSON.parse(allMatches[i]);
                            } catch (e) {
                                continue;
                            }
                        }
                    }
                }
            }

            console.error("Failed to parse JSON:", text);
            return {};
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

        const prompt = getProfileGenerationPrompt(forbiddenNames, nameInstruction);

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

