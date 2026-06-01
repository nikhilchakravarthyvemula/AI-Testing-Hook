// Shared types for the model-api-connector layer.
//
// JSDoc-style "interfaces" (no real types — this is Node, not TS).
// Every provider speaks this shape so consumers don't care which LLM
// they're hitting. This is the deliberately-minimal v1 — extend only
// when a real caller needs the field.

/**
 * @typedef {Object} ChatMessage
 * @property {"system"|"user"|"assistant"|"tool"} role
 * @property {string} content
 * @property {string} [name]      optional tool/function name
 */

/**
 * @typedef {Object} ChatRequest
 * @property {ChatMessage[]} messages
 * @property {string}        [model]           overrides provider default
 * @property {number}        [temperature]     0..2
 * @property {number}        [topP]            0..1
 * @property {number}        [maxTokens]       upper-bound output cap
 * @property {string[]}      [stop]            stop sequences
 * @property {boolean}       [stream=false]    streaming not implemented yet
 * @property {number}        [timeoutMs=60000] per-request abort timeout
 */

/**
 * @typedef {Object} ChatUsage
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [totalTokens]
 */

/**
 * @typedef {Object} ChatResponse
 * @property {string}     content       assistant message text
 * @property {string}     [finishReason] "stop" | "length" | "tool_call" | ...
 * @property {string}     model
 * @property {ChatUsage}  [usage]
 * @property {string}     provider      stable id, e.g. "minimax"
 * @property {object}     [raw]         provider-native response body for debugging
 */

/**
 * @typedef {Object} ModelClient
 * @property {string} provider
 * @property {string} defaultModel
 * @property {(req: ChatRequest) => Promise<ChatResponse>} chat
 */

// Re-export marker so this file is treated as an ES module by importers.
export const CONNECTOR_SCHEMA_VERSION = '1';
