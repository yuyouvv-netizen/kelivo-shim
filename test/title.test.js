import { test } from "node:test";
import assert from "node:assert/strict";
import { isKelivoTitleRequest, localTitleForRequest } from "../title.js";

const request = (content) => `I will give you some dialogue content in the \`<content>\` block.
You need to summarize the conversation between user and assistant into a short title.
1. The title language should be consistent with the user's primary language
2. Do not use punctuation or other special symbols
3. Reply directly with the title
4. Summarize using zh-CN language
5. The title should not exceed 10 characters

<content>
${content}
</content>`;

test("识别 Kelivo 默认自动标题请求", () => {
  assert.equal(isKelivoTitleRequest(request("User: 哥哥在吗\n\nAssistant: 在。")), true);
});

test("普通聊天和普通粘贴不误判为标题请求", () => {
  assert.equal(isKelivoTitleRequest("帮我给这段对话起一个标题"), false);
  assert.equal(isKelivoTitleRequest("<content>这只是我粘贴的一段文字</content>"), false);
});

test("标题取信息量最大的用户消息并限制十个字符", () => {
  const prompt = request([
    "User: 克克～",
    "",
    "Assistant: 我在。",
    "",
    "User: 我们继续讨论藤蔓和长期记忆系统应该怎么整理呀？",
  ].join("\n"));
  const title = localTitleForRequest(prompt);
  assert.equal(title, "我们继续讨论藤蔓和长");
  assert.equal(Array.from(title).length, 10);
});

test("标题移除标点和链接", () => {
  const title = localTitleForRequest(request("User: 哥哥，看看 https://example.com 这个！"));
  assert.equal(title, "哥哥看看这个");
});

test("空内容安全回退", () => {
  assert.equal(localTitleForRequest(request("")), "新对话");
});
