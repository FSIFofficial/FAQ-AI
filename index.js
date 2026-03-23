import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ========= 投稿時間制限 ========= */
function isAllowedTime() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();

  if (day === 0 || day === 6) {
    return hour >= 12 && hour < 22;
  }

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
  await scanUnansweredThreads();
});

/* ========= スレッド作成 ========= */
client.on("threadCreate", async (thread) => {
  if (!isAllowedTime()) return;
  if (thread.parentId !== process.env.QUESTION_CHANNEL_ID) return;
  if (thread.appliedTags.includes(process.env.AI_REPLIED_TAG_ID)) return;

  await handleThread(thread);
});

/* ========= メッセージ ========= */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  const thread = message.channel;

  if (message.mentions.has(client.user)) {
    if (!isAllowedTime()) return;

    const messages = await thread.messages.fetch({ limit: 50 });

    const text = [...messages.values()]
      .reverse()
      .filter(m => !m.author.bot)
      .map(m => `${m.author.username}: ${m.content}`)
      .join("\n");

    const reply = await generateAIReply(text);

    if (!reply) return;

    await thread.send("呼んでくれてありがとう。\n\n" + reply);
    return;
  }

  if (!thread.appliedTags.includes(process.env.HUMAN_REPLIED_TAG_ID)) {
    await thread.setAppliedTags([
      ...thread.appliedTags,
      process.env.HUMAN_REPLIED_TAG_ID,
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
    if (thread.appliedTags.includes(process.env.AI_REPLIED_TAG_ID)) continue;
    await handleThread(thread);
  }
}

/* ========= スレッド処理 ========= */
async function handleThread(thread) {

  let failCount = 0;
  const match = thread.name.match(/\[FAIL:(\d+)\]/);
  if (match) failCount = parseInt(match[1]);

  if (failCount >= 3) return;

  const messages = await thread.messages.fetch({ limit: 10 });

  const firstMessage = [...messages.values()]
    .reverse()
    .find(m => !m.author.bot);

  if (!firstMessage) return;

  const reply = await generateAIReply(firstMessage.content);

  if (reply) {
    await thread.send(reply);

    await thread.setAppliedTags([
      ...thread.appliedTags,
      process.env.AI_REPLIED_TAG_ID,
    ]);

    return;
  }

  failCount++;

  const newName = thread.name.replace(/\[FAIL:\d+\]/, "") + ` [FAIL:${failCount}]`;

  await thread.setName(newName);
}

/* ========= AI生成 ========= */
async function generateAIReply(text) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(
      SYSTEM_PROMPT + "\n\n" + text
    );

    return result.response.text();

  } catch (err) {
    console.log("Geminiエラー");
    return null;
  }
}

/* ========= ログイン ========= */
client.login(process.env.DISCORD_TOKEN);
