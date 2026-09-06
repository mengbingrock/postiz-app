const MAX_POST_ERROR_LENGTH = 4_000;

export const postErrorMessage = (error: unknown): string | null => {
  if (error === null || error === undefined) {
    return null;
  }

  if (error instanceof Error) {
    return postErrorMessage(error.message);
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'string' || parsed !== trimmed) {
        return (
          postErrorMessage(parsed) || trimmed.slice(0, MAX_POST_ERROR_LENGTH)
        );
      }
    } catch {
      // Plain provider messages are already the most useful representation.
    }

    return trimmed.slice(0, MAX_POST_ERROR_LENGTH);
  }

  if (typeof error === 'object') {
    const value = error as Record<string, unknown>;
    for (const key of [
      'message',
      'error_description',
      'error',
      'detail',
      'cause',
      'failure',
    ]) {
      const message = postErrorMessage(value[key]);
      if (message) {
        return message;
      }
    }

    try {
      return JSON.stringify(error).slice(0, MAX_POST_ERROR_LENGTH);
    } catch {
      return 'Unknown publication error';
    }
  }

  return String(error).slice(0, MAX_POST_ERROR_LENGTH);
};
