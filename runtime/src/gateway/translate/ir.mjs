// The translation's in-between shapes (P6.1). JSDoc only.
//
// A request, after responses-in.mjs:
/**
 * @typedef {object} TurnRequest
 * @property {string} model
 * @property {Array<ChatMessage>} messages       Chat-shaped, in order
 * @property {ReturnType<import("./tools.mjs").buildToolMap>} toolMap
 * @property {"auto"|"none"|"required"|{type:"function",function:{name:string}}|null} toolChoice
 * @property {boolean|null} parallelToolCalls
 * @property {number|null} maxOutputTokens
 * @property {string|null} reasoningEffort
 * @property {number|null} temperature
 * @property {number|null} topP
 * @property {object|null} responseFormat
 */
/**
 * @typedef {object} ChatMessage
 * @property {"system"|"user"|"assistant"|"tool"} role
 * @property {string|Array<object>|null} content
 * @property {Array<{id:string,type:"function",function:{name:string,arguments:string}}>} [tool_calls]
 * @property {string} [tool_call_id]
 * @property {string} [reasoning]   a provider's own reasoning, re-attached by its quirk (opened envelope)
 */
// Stream events, from an upstream parser (upstream/chat.mjs) to responses-out.mjs:
/**
 * @typedef {{t:"text",delta:string}
 *   | {t:"reasoning",delta:string}
 *   | {t:"tool",index:number,id?:string,name?:string,args?:string}
 *   | {t:"finish",reason:string|null}
 *   | {t:"usage",usage:object}
 *   | {t:"error",error:object}} StreamEvent
 */
export {};
