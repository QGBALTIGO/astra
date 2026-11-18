/** Raised by the service or adapter only before any platform transport was attempted. */
export class ChannelSendNotAttemptedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Mensagem não enviada antes do transporte.', {
      cause,
    });
    this.name = 'ChannelSendNotAttemptedError';
  }
}
