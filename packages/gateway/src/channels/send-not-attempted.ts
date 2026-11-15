/** Raised only by the channel service before it calls the transport API. */
export class ChannelSendNotAttemptedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Mensagem não enviada antes do transporte.', {
      cause,
    });
    this.name = 'ChannelSendNotAttemptedError';
  }
}
