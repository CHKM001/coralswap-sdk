/**
 * HTTP method used for the webhook callback.
 */
export type WebhookMethod = 'POST' | 'PUT' | 'PATCH';

/**
 * Format of the webhook payload body.
 * - `json`: Content-Type application/json
 * - `form`: Content-Type application/x-www-form-urlencoded
 */
export type WebhookPayloadFormat = 'json' | 'form';

/**
 * Delivery status of a webhook attempt.
 * - `pending`: queued and waiting for delivery
 * - `delivering`: currently being sent
 * - `success`: successfully delivered (2xx response)
 * - `failed`: non-2xx response or network error
 * - `exhausted`: all retry attempts exhausted
 */
export type WebhookDeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'success'
  | 'failed'
  | 'exhausted';

/**
 * Configuration for registering a webhook endpoint.
 */
export interface WebhookConfig {
  /**
   * URL to which the webhook payload is sent.
   * Must be a valid HTTPS URL.
   */
  url: string;
  /**
   * HTTP method for the request. Defaults to `POST`.
   */
  method?: WebhookMethod;
  /**
   * Payload serialisation format. Defaults to `json`.
   */
  payloadFormat?: WebhookPayloadFormat;
  /**
   * Custom HTTP headers to include in every delivery.
   * The `Content-Type` and `X-CoralSwap-Signature` headers are set
   * automatically and must not be overridden here.
   */
  headers?: Record<string, string>;
  /**
   * Optional secret used to compute the HMAC-SHA256 signature.
   * When set, every webhook payload is signed and the signature
   * is sent in the `X-CoralSwap-Signature` header.
   *
   * @see {@link https://docs.coralswap.finance/webhooks#hmac | Webhook HMAC documentation}
   */
  secret?: string;
  /**
   * Human-readable label for this endpoint (e.g. "Discord alerts").
   */
  label?: string;
  /**
   * Alert IDs that should be delivered to this endpoint.
   * An empty array means all alerts are forwarded.
   */
  alertFilter?: string[];
  /**
   * Whether the endpoint is active. Defaults to `true`.
   */
  enabled?: boolean;
}

/**
 * Delivery metadata recorded for a single webhook attempt.
 */
export interface WebhookDelivery {
  /** Unique delivery identifier */
  id: string;
  /** Webhook endpoint ID that received this delivery */
  webhookId: string;
  /** Alert instance ID that triggered this delivery */
  alertId: string;
  /** Current delivery status */
  status: WebhookDeliveryStatus;
  /** HTTP status code returned by the endpoint (undefined on network error) */
  httpStatus?: number;
  /** Unix timestamp (seconds) when delivery was initiated */
  sentAt: number;
  /** Unix timestamp (seconds) when the endpoint responded */
  completedAt?: number;
  /** Number of retry attempts made so far */
  retryCount: number;
  /** Error message if delivery failed */
  errorMessage?: string;
}

/**
 * Webhook delivery guarantees:
 *
 * - **At-least-once delivery**: every fired alert triggers at least one delivery
 *   attempt. Duplicates are possible if the endpoint acknowledges after a timeout.
 * - **Retry policy**: failed deliveries are retried up to 3 times with exponential
 *   backoff (30 s, 2 min, 10 min). After all retries are exhausted the delivery
 *   is marked `exhausted`.
 * - **Ordering**: deliveries are dispatched in the order alerts fire, but network
 *   conditions may cause out-of-order arrival. Use the `id` field for sequencing.
 * - **HMAC signing**: when a `secret` is configured, every payload includes an
 *   `X-CoralSwap-Signature` header containing the HMAC-SHA256 digest of the
 *   request body. Verify this signature on your endpoint to guarantee the payload
 *   originated from CoralSwap.
 *
 * @example
 * // Node.js HMAC verification
 * import { createHmac, timingSafeEqual } from 'node:crypto';
 *
 * function verifySignature(payload: string, signature: string, secret: string): boolean {
 *   const expected = createHmac('sha256', secret).update(payload).digest('hex');
 *   return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
 * }
 *
 * // Use in Express:
 * app.post('/webhook', (req, res) => {
 *   const sig = req.headers['x-coralswap-signature'];
 *   if (!sig || !verifySignature(JSON.stringify(req.body), sig, WEBHOOK_SECRET)) {
 *     return res.status(401).send('invalid signature');
 *   }
 *   res.status(200).send('ok');
 * });
 */
export interface WebhookDeliveryGuarantees {
  atLeastOnce: true;
  maxRetries: 3;
  backoffSchedule: [30000, 120000, 600000];
  ordering: 'best-effort';
  hmacAlgorithm: 'sha256';
}

/**
 * Summary of webhook endpoint health.
 */
export interface WebhookEndpointHealth {
  /** Webhook endpoint ID */
  webhookId: string;
  /** Endpoint URL */
  url: string;
  /** Whether the endpoint is currently enabled */
  enabled: boolean;
  /** Total deliveries attempted */
  totalDeliveries: number;
  /** Successful deliveries */
  successfulDeliveries: number;
  /** Failed deliveries */
  failedDeliveries: number;
  /** Success rate as a fraction (0–1) */
  successRate: number;
  /** Average response time in milliseconds */
  averageResponseTimeMs: number;
  /** Timestamp of the last delivery attempt */
  lastDeliveryAt?: number;
}
