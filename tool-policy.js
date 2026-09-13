// Keep the MCP servers connected, but hide tools that are not part of this
// deployment's day-to-day surface. Claude Code treats an exact bare entry in
// --disallowedTools as unavailable to the model. Full names are intentional:
// no server-wide wildcard may hide a retained tool by accident.
export const DEFAULT_DISALLOWED_MCP_TOOLS = Object.freeze([
  // Gmail: retain send_email, search_emails and read_email.
  "mcp__gmail__draft_email",
  "mcp__gmail__download_attachment",
  "mcp__gmail__modify_email",
  "mcp__gmail__delete_email",
  "mcp__gmail__list_email_labels",
  "mcp__gmail__create_label",
  "mcp__gmail__update_label",
  "mcp__gmail__delete_label",
  "mcp__gmail__get_or_create_label",
  "mcp__gmail__batch_modify_emails",
  "mcp__gmail__batch_delete_emails",
  "mcp__gmail__create_filter",
  "mcp__gmail__list_filters",
  "mcp__gmail__get_filter",
  "mcp__gmail__delete_filter",
  "mcp__gmail__create_filter_from_template",

  // Garden: retain the forum and bottle tools.
  "mcp__garden__join_game",
  "mcp__garden__start_game",
  "mcp__garden__leave_waiting_game",
  "mcp__garden__list_games",
  "mcp__garden__get_my_status",
  "mcp__garden__submit_action",
  "mcp__garden__get_game_summary",
  "mcp__garden__send_game_chat",
  "mcp__garden__get_chat_messages",
  "mcp__garden__send_chat_message",
  "mcp__garden__withdraw_chat_message",
  "mcp__garden__get_tool_schema",
  "mcp__garden__nostos_start",
  "mcp__garden__nostos_act",
  "mcp__garden__nostos_status",

  // Browser: retain handle_dialog, type_text and all x_* tools.
  "mcp__browser__fill_form",
  "mcp__browser__hover",
  "mcp__browser__select_page",
  "mcp__browser__close_page",
]);

export function configuredDisallowedTools(raw = process.env.DISALLOWED_TOOLS) {
  const values = raw === undefined
    ? DEFAULT_DISALLOWED_MCP_TOOLS
    : String(raw).split(",");
  return [...new Set(values.map((name) => name.trim()).filter(Boolean))];
}
