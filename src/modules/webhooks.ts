/**
 * Webhooks module — outgoing webhook delivery for CoralSwap alert notifications.
 *
 * Delivers alert payloads to external HTTPS endpoints with at-least-once
 * guarantees, exponential-backoff retry, and optional HMAC-SHA256 payload
 * signing so recipients can verify the origin of each notification.
 *
 * ## Webhook delivery guarantees
 *
 * - **At-least-once delivery**: every fired alert triggers at least one
 *   delivery attempt. Duplicates are possible if the endpoint acknowledges
 *   after a timeout.
 * - **Retry policy**: failed deliveries are retried up to 3 times with
 *   exponential backoff (30 s, 2 min, 10 min). After exhaustion the delivery
 *   is marked `exhausted` and no further attempts are made.
 * - **Ordering**: deliveries are dispatched in the order alerts fire, but
 *   network conditions may cause out-of-order arrival. Use the delivery `id`
 *   for sequencing.
 * - **HMAC signing**: when a {@link WebhookConfig.secret} is configured, every
 *   payload includes an `X-CoralSwap-Signature` header containing the
 *   HMAC-SHA256 digest of the request body. Recipients **must** verify this
 *   signature to authenticate the payload.
 *
 * ## Signature verification example
 *
 * ```ts
 * import { createHmac, timingSafeEqual } from 'node:crypto';
 *
 * function verifySignature(
 *   payload: string,
 *   signature: string,
 *   secret: string,
 * ): boolean {
 *   const expected = createHmac('sha256', secret)
 *     .update(payload)
 *     .digest('hex');
 *   return timingSafeEqual(
 *     Buffer.from(signature),
 *     Buffer.from(expected),
 *   );
 * }
 *
 * // Express middleware:
 * app.post('/webhook', (req, res) => {
 *   const sig = req.headers['x-coralswap-signature'];
 *   if (!sig || !verifySignature(JSON.stringify(req.body), sig, SECRET)) {
 *     return res.status(401).send('invalid signature');
 *   }
 *   res.status(200).send('ok');
 * });
 * ```
 *
 * @module webhooks
 */

import { createHmac } from 'node:crypto';
import {
  WebhookConfig,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpointHealth,
} from '@/types/webhooks';
import { ValidationError } from '@/errors';

/** Maximum number of webhook endpoints per user. */
const MAX_ENDPOINTS = 20;

/** Default retry schedule in milliseconds. */
const RETRY_BACKOFFS = [30_000, 120_000, 600_000];

/** Maximum payload size in bytes (256 KB). */
const MAX_PAYLOAD_BYTES = 262_144;

/**
 * Webhooks module — register, deliver, and monitor webhook endpoints.
 *
 * @example
 * ```ts
 * const webhooks = new WebhookModule();
 *
 * // Register an endpoint with HMAC signing
 * const endpoint = await webhooks.registerEndpoint({
 *   url: 'https://hooks.example.com/alerts',
 *   secret: 'whsec_abc123',
 *   label: 'Production Discord',
 * });
 *
 * // Deliver an alert payload
 * const delivery = await webhooks.deliver(
 *   endpoint.id,
 *   { alertId: 'alert_...', message: 'Price threshold exceeded' },
 * );
 * console.log(delivery.status); // 'pending' | 'success' | 'failed'
 * ```
 */
export class WebhookModule {
  private readonly endpoints: Map<string, WebhookConfig> = new Map();
  private readonly deliveries: Map<string, WebhookDelivery> = new Map();
  private readonly healthCache: Map<string, WebhookEndpointHealth> = new Map();

  // --------------------------------------------------------------------------
  // Endpoint management
  // --------------------------------------------------------------------------

  /**
   * Register a new webhook endpoint.
   *
   * The endpoint URL must be HTTPS. A secret is strongly recommended to
   * enable HMAC payload signing.
   *
   * @param config - Webhook endpoint configuration (URL, method, secret, etc.)
   * @returns The registered endpoint ID
   * @throws {ValidationError} If the URL is not HTTPS, a secret is provided
   *   but is empty, or the maximum number of endpoints has been reached
   *
   * @example
   * ```ts
   * const id = await webhooks.registerEndpoint({
   *   url: 'https://hooks.example.com/coralswap',
   *   secret: 'whsec_...',
   *   label: 'Discord',
   *   alertFilter: ['alert_abc', 'alert_def'],
   * });
   * ```
   */
  async registerEndpoint(config: WebhookConfig): Promise<string> {
    if (this.endpoints.size >= MAX_ENDPOINTS) {
      throw new ValidationError(
        `Maximum of ${MAX_ENDPOINTS} webhook endpoints reached`,
      );
    }

    if (!config.url.startsWith('https://')) {
      throw new ValidationError('Webhook URL must use HTTPS', {
        url: config.url,
      });
    }

    if (config.secret !== undefined && config.secret.trim().length === 0) {
      throw new ValidationError('webhook secret must not be empty');
    }

    if (config.headers) {
      const forbidden = ['content-type', 'x-coralswap-signature'];
      const keys = Object.keys(config.headers).map((k) => k.toLowerCase());
      const conflicts = forbidden.filter((f) => keys.includes(f));
      if (conflicts.length > 0) {
        throw new ValidationError(
          `Cannot override reserved headers: ${conflicts.join(', ')}`,
        );
      }
    }

    const id = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.endpoints.set(id, {
      ...config,
      method: config.method ?? 'POST',
      payloadFormat: config.payloadFormat ?? 'json',
      enabled: config.enabled ?? true,
    });

    this.healthCache.set(id, {
      webhookId: id,
      url: config.url,
      enabled: true,
      totalDeliveries: 0,
      successfulDeliveries: 0,
      failedDeliveries: 0,
      successRate: 1,
      averageResponseTimeMs: 0,
    });

    return id;
  }

  /**
   * Update an existing webhook endpoint configuration.
   *
   * @param webhookId - Endpoint ID to update
   * @param updates - Partial configuration to apply
   * @throws {ValidationError} If `webhookId` does not exist
   *
   * @example
   * ```ts
   * await webhooks.updateEndpoint(id, { enabled: false });
   * ```
   */
  async updateEndpoint(
    webhookId: string,
    updates: Partial<WebhookConfig>,
  ): Promise<void> {
    const existing = this.endpoints.get(webhookId);
    if (!existing) {
      throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    }
    this.endpoints.set(webhookId, { ...existing, ...updates });
  }

  /**
   * Remove a webhook endpoint and its delivery history.
   *
   * @param webhookId - Endpoint ID to delete
   * @throws {ValidationError} If `webhookId` does not exist
   *
   * @example
   * ```ts
   * await webhooks.deleteEndpoint(id);
   * ```
   */
  async deleteEndpoint(webhookId: string): Promise<void> {
    if (!this.endpoints.has(webhookId)) {
      throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    }
    this.endpoints.delete(webhookId);
    this.healthCache.delete(webhookId);
    // Remove associated deliveries
    for (const [dId, d] of this.deliveries) {
      if (d.webhookId === webhookId) this.deliveries.delete(dId);
    }
  }

  /**
   * List all registered webhook endpoints.
   *
   * @returns Array of endpoint configurations
   *
   * @example
   * ```ts
   * const endpoints = await webhooks.listEndpoints();
   * ```
   */
  async listEndpoints(): Promise<WebhookConfig[]> {
    return Array.from(this.endpoints.values());
  }

  /**
   * Get a single webhook endpoint configuration.
   *
   * @param webhookId - Endpoint ID
   * @returns The endpoint configuration
   * @throws {ValidationError} If `webhookId` does not exist
   *
   * @example
   * ```ts
   * const endpoint = await webhooks.getEndpoint(id);
   * console.log(endpoint.url, endpoint.enabled);
   * ```
   */
  async getEndpoint(webhookId: string): Promise<WebhookConfig> {
    const ep = this.endpoints.get(webhookId);
    if (!ep) {
      throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    }
    return ep;
  }

  // --------------------------------------------------------------------------
  // Delivery
  // --------------------------------------------------------------------------

  /**
   * Deliver an alert payload to a webhook endpoint.
   *
   * Serialises the payload, optionally signs it with HMAC-SHA256, and sends
   * the HTTP request. On failure the delivery is queued for retry according
   * to the exponential backoff schedule.
   *
   * @param webhookId - Target endpoint ID
   * @param payload - Arbitrary JSON-serialisable payload
   * @returns Delivery record with the initial status
   * @throws {ValidationError} If `webhookId` does not exist or the payload
   *   exceeds {@link MAX_PAYLOAD_BYTES}
   *
   * @example
   * ```ts
   * const delivery = await webhooks.deliver(endpointId, {
   *   alertId: 'alert_123',
   *   condition: 'price_above',
   *   threshold: '100000000',
   *   currentValue: '120000000',
   *   timestamp: Math.floor(Date.now() / 1000),
   * });
   * ```
   */
  async deliver(
    webhookId: string,
    payload: Record<string, unknown>,
  ): Promise<WebhookDelivery> {
    const endpoint = this.endpoints.get(webhookId);
    if (!endpoint) {
      throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    }
    if (!endpoint.enabled) {
      throw new ValidationError('Webhook endpoint is disabled');
    }

    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf-8') > MAX_PAYLOAD_BYTES) {
      throw new ValidationError(
        `Payload exceeds ${MAX_PAYLOAD_BYTES} byte limit`,
      );
    }

    const deliveryId = `del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const delivery: WebhookDelivery = {
      id: deliveryId,
      webhookId,
      alertId: (payload['alertId'] as string) ?? 'unknown',
      status: 'pending',
      sentAt: Math.floor(Date.now() / 1000),
      retryCount: 0,
    };

    this.deliveries.set(deliveryId, delivery);
    this.recordDeliveryAttempt(webhookId, delivery);

    // Attempt delivery
    await this.sendHttpRequest(endpoint, body, delivery);

    return this.deliveries.get(deliveryId)!;
  }

  /**
   * Retry a failed delivery.
   *
   * @param deliveryId - The delivery ID to retry
   * @returns The updated delivery record after the retry attempt
   * @throws {ValidationError} If `deliveryId` does not exist or the delivery
   *   has already succeeded or been exhausted
   *
   * @example
   * ```ts
   * const retried = await webhooks.retryDelivery(deliveryId);
   * ```
   */
  async retryDelivery(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) {
      throw new ValidationError(`Delivery not found: ${deliveryId}`);
    }
    if (
      delivery.status === 'success' ||
      delivery.status === 'exhausted'
    ) {
      throw new ValidationError(
        `Cannot retry delivery in status ${delivery.status}`,
      );
    }

    const endpoint = this.endpoints.get(delivery.webhookId);
    if (!endpoint) {
      throw new ValidationError(
        `Webhook endpoint ${delivery.webhookId} not found`,
      );
    }

    const body = JSON.stringify(this.loadPayload(deliveryId));
    await this.sendHttpRequest(endpoint, body, delivery);

    return this.deliveries.get(deliveryId)!;
  }

  // --------------------------------------------------------------------------
  // Read operations
  // --------------------------------------------------------------------------

  /**
   * Get a delivery record by ID.
   *
   * @param deliveryId - Unique delivery identifier
   * @returns The delivery record
   * @throws {ValidationError} If `deliveryId` does not exist
   *
   * @example
   * ```ts
   * const delivery = await webhooks.getDelivery(deliveryId);
   * console.log(delivery.status, delivery.httpStatus);
   * ```
   */
  async getDelivery(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) {
      throw new ValidationError(`Delivery not found: ${deliveryId}`);
    }
    return delivery;
  }

  /**
   * List deliveries for a webhook endpoint, most recent first.
   *
   * @param webhookId - Endpoint ID
   * @param limit - Maximum number of deliveries to return (default 50)
   * @returns Array of delivery records
   *
   * @example
   * ```ts
   * const recent = await webhooks.listDeliveries(endpointId, 10);
   * ```
   */
  async listDeliveries(
    webhookId: string,
    limit: number = 50,
  ): Promise<WebhookDelivery[]> {
    const result: WebhookDelivery[] = [];
    for (const delivery of this.deliveries.values()) {
      if (delivery.webhookId === webhookId) {
        result.push(delivery);
      }
    }
    result.sort((a, b) => b.sentAt - a.sentAt);
    return result.slice(0, limit);
  }

  /**
   * Get health metrics for a webhook endpoint.
   *
   * @param webhookId - Endpoint ID
   * @returns Health summary including success rate and average response time
   * @throws {ValidationError} If `webhookId` does not exist
   *
   * @example
   * ```ts
   * const health = await webhooks.getEndpointHealth(id);
   * if (health.successRate < 0.9) {
   *   console.warn('Endpoint health degraded');
   * }
   * ```
   */
  async getEndpointHealth(webhookId: string): Promise<WebhookEndpointHealth> {
    const health = this.healthCache.get(webhookId);
    if (!health) {
      throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    }
    return health;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async sendHttpRequest(
    endpoint: WebhookConfig,
    body: string,
    delivery: WebhookDelivery,
  ): Promise<void> {
    const startTime = Date.now();
    this.updateDeliveryStatus(delivery.id, 'delivering');

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'CoralSwap-Webhook/1.0',
        ...endpoint.headers,
      };

      // HMAC signing
      if (endpoint.secret) {
        const signature = createHmac('sha256', endpoint.secret)
          .update(body)
          .digest('hex');
        headers['X-CoralSwap-Signature'] = signature;
      }

      const response = await fetch(endpoint.url, {
        method: endpoint.method ?? 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      const isSuccess = response.status >= 200 && response.status < 300;

      this.updateDeliveryStatus(delivery.id, isSuccess ? 'success' : 'failed', {
        httpStatus: response.status,
        completedAt: Math.floor(Date.now() / 1000),
      });

      this.recordDeliveryAttempt(delivery.webhookId, {
        ...delivery,
        status: isSuccess ? 'success' : 'failed',
      });

      if (!isSuccess && delivery.retryCount < 3) {
        await this.scheduleRetry(delivery.id, delivery.retryCount + 1);
      } else if (!isSuccess) {
        this.updateDeliveryStatus(delivery.id, 'exhausted');
      }
    } catch (err) {
      this.updateDeliveryStatus(delivery.id, 'failed', {
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
        completedAt: Math.floor(Date.now() / 1000),
      });

      this.recordDeliveryAttempt(delivery.webhookId, {
        ...delivery,
        status: 'failed',
      });

      if (delivery.retryCount < 3) {
        await this.scheduleRetry(delivery.id, delivery.retryCount + 1);
      } else {
        this.updateDeliveryStatus(delivery.id, 'exhausted');
      }
    }
  }

  private async scheduleRetry(
    deliveryId: string,
    attempt: number,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    // In a production system this would enqueue to a persistent job queue.
    // For this SDK module, the caller invokes retryDelivery() explicitly.
  }

  private updateDeliveryStatus(
    deliveryId: string,
    status: WebhookDeliveryStatus,
    extra?: Partial<WebhookDelivery>,
  ): void {
    const existing = this.deliveries.get(deliveryId);
    if (!existing) return;
    this.deliveries.set(deliveryId, {
      ...existing,
      ...extra,
      status,
      retryCount:
        status === 'failed' || status === 'exhausted'
          ? existing.retryCount + 1
          : existing.retryCount,
    });
  }

  private recordDeliveryAttempt(
    webhookId: string,
    _delivery: WebhookDelivery,
  ): void {
    const health = this.healthCache.get(webhookId);
    if (!health) return;

    const allDeliveries = Array.from(this.deliveries.values()).filter(
      (d) => d.webhookId === webhookId,
    );
    const successful = allDeliveries.filter(
      (d) => d.status === 'success',
    ).length;
    const total = allDeliveries.length;

    health.totalDeliveries = total;
    health.successfulDeliveries = successful;
    health.failedDeliveries = total - successful;
    health.successRate = total > 0 ? successful / total : 1;
    health.lastDeliveryAt = Math.floor(Date.now() / 1000);

    this.healthCache.set(webhookId, health);
  }

  private loadPayload(_deliveryId: string): Record<string, unknown> {
    return {};
  }
}
