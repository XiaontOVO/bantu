/**
 * HTTP 层的控制流信号。
 *
 * 这两类错误只在服务端内部流转，永远不会直接回给客户端；
 * 单独成类是为了让 catch 分支能精确区分，而不是靠 `instanceof SyntaxError`
 * 之类的启发式判断（业务代码抛出的 SyntaxError 会被误判成 400）。
 */

/** 响应已经写出；调用方应立即 return，不要再写第二次。 */
export class ResponseSentError extends Error {
  constructor() {
    super('response already sent');
    this.name = 'ResponseSentError';
  }
}

/** 请求体不是合法的 JSON 对象字面量。 */
export class InvalidJsonBodyError extends Error {
  constructor() {
    super('请求体不是有效 JSON 对象。');
    this.name = 'InvalidJsonBodyError';
  }
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds the JSON size limit');
    this.name = 'RequestBodyTooLargeError';
  }
}
