/**
 * Echo Bot
 *
 * A minimal mock bot that receives channel messages and echoes them back.
 * Demonstrates how a channel plugin's inbound message flow can be wired
 * to a simple responder instead of a full LLM agent.
 *
 * The bot exposes:
 *  - `handleMessage()` — process a simulated Feishu inbound message event
 *  - `getHistory()`    — retrieve the conversation log for debugging
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EchoBotMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  chatId: string;
  senderId: string;
  text: string;
  timestamp: number;
}

export interface InboundMessagePayload {
  /** Feishu message_id */
  messageId: string;
  /** Feishu chat_id */
  chatId: string;
  /** Feishu sender open_id */
  senderId: string;
  /** Message text content */
  text: string;
  /** Chat type */
  chatType?: 'p2p' | 'group';
}

export interface EchoBotReply {
  messageId: string;
  chatId: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Echo Bot
// ---------------------------------------------------------------------------

export class EchoBot {
  private history: EchoBotMessage[] = [];
  private messageCounter = 0;

  /** Process an inbound message and return the echo reply. */
  handleMessage(payload: InboundMessagePayload): EchoBotReply {
    const now = Date.now();

    // Record inbound
    this.history.push({
      id: payload.messageId,
      direction: 'inbound',
      chatId: payload.chatId,
      senderId: payload.senderId,
      text: payload.text,
      timestamp: now,
    });

    // Build echo reply
    this.messageCounter++;
    const replyId = `echo_${this.messageCounter}_${Date.now()}`;
    const replyText = `🤖 Echo: ${payload.text}`;

    // Record outbound
    this.history.push({
      id: replyId,
      direction: 'outbound',
      chatId: payload.chatId,
      senderId: 'echo-bot',
      text: replyText,
      timestamp: Date.now(),
    });

    console.info(
      `[echo-bot] ${payload.chatId} | ${payload.senderId}: "${payload.text}" → "${replyText}"`,
    );

    return {
      messageId: replyId,
      chatId: payload.chatId,
      text: replyText,
    };
  }

  /** Retrieve the full conversation history (for debugging / API). */
  getHistory(): EchoBotMessage[] {
    return [...this.history];
  }

  /** Clear conversation history. */
  clearHistory(): void {
    this.history = [];
  }
}
