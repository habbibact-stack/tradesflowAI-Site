// ============================================================
// TradesFlow AI — Cloudflare Worker v6
// Route: POST / → Anthropic Claude Haiku → JSON { reply }
// Features:
//   - Server-side IP rate limiting (30 msgs / IP / hour)
//   - CORS headers for tradesflowai.co.uk + localhost dev
//   - Greeting mode (isGreeting: true sends no user message)
//   - Lead data forwarded to Google Apps Script webhook
// ============================================================

export default {
  async fetch(request, env, ctx) {

    // ── CORS ──────────────────────────────────────────────
    const allowedOrigins = [
      'https://tradesflowai.co.uk',
      'https://www.tradesflowai.co.uk',
      'http://127.0.0.1:5500',
      'http://localhost:5500',
      'http://localhost:3000',
      // GitHub Pages origin — update once you know your Pages URL
      'https://haggis2025.github.io',
    ];

    const origin = request.headers.get('Origin') || '';
    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    // Pre-flight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── IP RATE LIMITING ──────────────────────────────────
    // Requires a Cloudflare KV namespace bound as RATE_LIMIT_KV
    // in your Worker settings. Create it in the CF dashboard:
    //   Workers & Pages → KV → Create namespace "RATE_LIMIT"
    //   Then bind it to this Worker as variable name RATE_LIMIT_KV
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitKey = `rl:${ip}`;
    const LIMIT = 30;       // max messages per window
    const WINDOW_SECS = 3600; // 1 hour window

    try {
      if (env.RATE_LIMIT_KV) {
        const current = await env.RATE_LIMIT_KV.get(rateLimitKey);
        const count = current ? parseInt(current, 10) : 0;

        if (count >= LIMIT) {
          return new Response(
            JSON.stringify({
              error: 'rate_limited',
              reply: "You've sent a lot of messages — please try again in an hour, or book a free call to see the full system in action."
            }),
            { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Increment — set TTL only on first message in window
        await env.RATE_LIMIT_KV.put(
          rateLimitKey,
          String(count + 1),
          { expirationTtl: WINDOW_SECS }
        );
      }
    } catch (e) {
      // If KV isn't set up yet, log and continue — don't break the chat
      console.error('Rate limit KV error:', e.message);
    }

    // ── PARSE BODY ────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { messages = [], isGreeting = false } = body;

    // ── SYSTEM PROMPT ─────────────────────────────────────
    const SYSTEM_PROMPT = `You are Amy, the AI receptionist for TradesFlow AI. TradesFlow AI is a UK company that installs done-for-you AI systems for tradespeople — plumbers, electricians, builders, roofers, heating engineers, plasterers and landscapers.

Your role on this website is to act as a live demo of what Amy does for a tradesperson's customers. The person chatting with you right now is likely a tradesperson or business owner evaluating whether to buy TradesFlow AI — NOT a customer with a job to book.

Behave exactly as you would if you were installed on a real tradesperson's website: greet them, ask what job they need help with, collect their name, phone number, full address (including postcode), job description, and urgency. Keep the conversation natural, warm and professional. Use plain British English. Do not use bullet points or numbered lists in your replies — write in natural conversational sentences only.

IMPORTANT RULES:
- Never give safety, emergency or medical advice of any kind. If someone mentions anything urgent or dangerous (gas leak, flooding, electrical fault), tell them to call 999 or the relevant emergency service immediately and end the conversation there.
- Never make up prices, timescales or guarantees on behalf of any tradesperson.
- Do not mention competitor AI products or services.
- Keep replies concise — no more than 3 sentences per message where possible.
- Once you have collected name, phone number, address and job description, confirm the details back to the customer warmly and let them know someone will be in touch shortly. End the conversation professionally at that point.
- Do not continue collecting further information after you have confirmed the lead details.`;

    // ── BUILD MESSAGES ARRAY ──────────────────────────────
    let apiMessages = [];

    if (isGreeting) {
      // Trigger Amy to open the conversation herself
      apiMessages = [{
        role: 'user',
        content: 'Please greet the visitor warmly and ask how you can help them today. Keep it to 2 sentences maximum.'
      }];
    } else {
      if (!Array.isArray(messages) || messages.length === 0) {
        return new Response(JSON.stringify({ error: 'No messages provided' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      apiMessages = messages;
    }

    // ── CALL ANTHROPIC ────────────────────────────────────
    let amyReply = '';
    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: SYSTEM_PROMPT,
          messages: apiMessages,
        }),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        console.error('Anthropic error:', errText);
        throw new Error(`Anthropic ${anthropicRes.status}`);
      }

      const anthropicData = await anthropicRes.json();
      amyReply = anthropicData?.content?.[0]?.text?.trim() || '';

    } catch (e) {
      console.error('Anthropic fetch failed:', e.message);
      return new Response(
        JSON.stringify({ reply: "Sorry, I'm having a little trouble connecting right now. Please try again in a moment, or feel free to call us directly." }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── DETECT LEAD COMPLETION & FORWARD TO GOOGLE SHEETS ─
    // Check if Amy has wrapped up the lead capture
    const wrapPhrases = [
      'thank you', 'thanks for', "we'll be in touch", 'we will be in touch',
      'all noted', 'got everything', "i've got everything", 'i have everything',
      'someone will', 'get back to you', "i've noted", 'i have noted'
    ];
    const isLeadComplete = wrapPhrases.some(p => amyReply.toLowerCase().includes(p));

    if (isLeadComplete && Array.isArray(messages) && messages.length > 0) {
      // Extract lead data from conversation — best effort
      const fullConversation = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `${m.role === 'user' ? 'Customer' : 'Amy'}: ${m.content}`)
        .join('\n');

      const leadPayload = {
        timestamp: new Date().toISOString(),
        source: 'Website Demo Chat',
        conversation: fullConversation,
        amyFinalReply: amyReply,
      };

      // Forward to Google Apps Script — fire-and-forget
      if (env.GOOGLE_WEBHOOK_URL) {
        ctx.waitUntil(
          fetch(env.GOOGLE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(leadPayload),
            redirect: 'follow',
          }).catch(e => console.error('Webhook error:', e.message))
        );
      }
    }

    // ── RESPOND ───────────────────────────────────────────
    return new Response(
      JSON.stringify({ reply: amyReply }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
};
