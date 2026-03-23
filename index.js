import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import OpenAI from "openai";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ========= 投稿時間制限 ========= */
function isAllowedTime() {
  const now = new Date();
  const day = now.getDay(); 
  // 0日 6土
  const hour = now.getHours();
  // 土日
  if (day === 0 || day === 6) {
    return hour >= 12 && hour < 22;
  }
  // 平日
  return hour >= 7 && hour < 22;
}

/* ========= プロンプト ========= */
const SYSTEM_PROMPT = `
あなたは「Cosmo Base」という、初心者歓迎の宇宙コミュニティのAIです。
宇宙に詳しくない人にも寄り添い、「宇宙を身近な選択肢」に感じてもらうことが役割です。

回答ルール：
・最初の質問に対して1回だけ返信する
・断定しすぎず、現実的な距離感を大切にする
・専門用語は極力使わず、やさしい言葉で説明する
・未来を過度に煽らない
・見出しや箇条書きは使わない
・質問者を否定しない
・回答は3〜6文程度に収める

文体・トーン：
・落ち着いていて、少しワクワクを残す
・「教える」ではなく「一緒に考える」姿勢
・上から目線にならない

回答の締め：
・最後は必ず、
  「他の人はどう考えているのか、ちょっと聞いてみたいな」
  「いろんな視点がありそうで、気になるな」
  などのように、
“自分も興味を持っている”ニュアンスで終える
・「聞いてみてください」「質問してみてください」は使わない
`;


/* ========= 起動 ========= */
client.once("clientReady", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try {
    await scanUnansweredThreads();
  } catch (err) {
    console.error("起動スキャン失敗:", err);
  }
});

/* ========= 新規スレッド作成 ========= */

client.on("threadCreate", async (thread) => {
  try {
    if (!isAllowedTime()) return;
    if (thread.parentId !== process.env.QUESTION_CHANNEL_ID) return;
    if (thread.appliedTags.includes(process.env.AI_REPLIED_TAG_ID)) return;
    await handleThread(thread);
  } catch (err) {
    console.error("threadCreate error:", err);
  }
});

/* ========= メッセージ検知 ========= */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  const thread = message.channel;

  /* ========= メンションされたら再回答 ========= */
  if (message.mentions.has(client.user)) {
    if (!isAllowedTime()) return;
    console.log("メンション検知");
    const messages = await thread.messages.fetch({ limit: 100 });
    const conversation = [...messages.values()]
      .reverse()
      .filter(m => !m.author.bot)
      .map(m => `${m.author.username}: ${m.content}`)
      .join("\n");

    const aiReply = await generateAIReply(conversation);
    if (!aiReply) return;
    await thread.send(
      "呼んでくれてありがとう。ちょっと考えてみたよ。\n\n" + aiReply
    );
    return;
  }

  /* ========= 人間返信タグ ========= */
  if (!thread.appliedTags.includes(process.env.HUMAN_REPLIED_TAG_ID)) {
    await thread.setAppliedTags([
      ...thread.appliedTags,
      process.env.HUMAN_REPLIED_TAG_ID
    ]);
  }
});

/* ========= 起動時スキャン ========= */
async function scanUnansweredThreads() {
  if (!isAllowedTime()) return;
  const channel = await client.channels.fetch(
    process.env.QUESTION_CHANNEL_ID
  );
  if (channel.type !== ChannelType.GuildForum) return;
  const threads = await channel.threads.fetchActive();
  for (const thread of threads.threads.values()) {
    if (thread.appliedTags.includes(process.env.AI_REPLIED_TAG_ID))
      continue;
    await handleThread(thread);
  }
}

/* ========= スレッド処理 ========= */
async function handleThread(thread) {
  try {

    // ===== すでに成功済みなら終了 =====
    if (thread.appliedTags.includes(process.env.AI_REPLIED_TAG_ID)) {
      return;
    }

    // ===== 失敗回数取得 =====
    let failCount = 0;
    const match = thread.name.match(/\[FAIL:(\d+)\]/);
    if (match) {
      failCount = parseInt(match[1]);
    }

    // ===== 3回失敗で打ち止め =====
    if (failCount >= 3) {
      console.log("失敗上限 → スキップ");
      return;
    }
    const messages = await thread.messages.fetch({ limit: 10 });
    const firstMessage = [...messages.values()]
      .reverse()
      .find((m) => !m.author.bot);
    if (!firstMessage) return;
    console.log("AI回答生成:", firstMessage.content);
    const aiReply = await generateAIReply(firstMessage.content);

    // ===== 成功 =====
    if (aiReply) {
      await thread.send(aiReply);
      await thread.setAppliedTags([
        ...thread.appliedTags,
        process.env.AI_REPLIED_TAG_ID,
      ]);
      console.log("AI回答成功");
      return;
    }

    // ===== 失敗（再試行） =====
    failCount++;
    let newName;
    if (thread.name.match(/\[FAIL:\d+\]/)) {
      newName = thread.name.replace(/\[FAIL:\d+\]/, `[FAIL:${failCount}]`);
    } else {
      newName = thread.name + ` [FAIL:${failCount}]`;
    }
    await thread.setName(newName);
    console.log(`AI失敗 → 次回再試行 (${failCount})`);
  } catch (err) {
    console.error("handleThread error:", err);
  }
}

/* ========= AI生成 ========= */
async function generateAIReply(text) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: text
        }
      ],
    });
    return res.choices[0].message.content;
  } catch (err) {
    if (err.code === "insufficient_quota") {
      console.log("Quota不足 → スキップ");
      return null;
    }
    console.error(err);
    return null;
  }
}

/* ========= ログイン ========= */
client.login(process.env.DISCORD_TOKEN);
