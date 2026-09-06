// Timeout per chiamate esterne. Il timer viene sempre pulito (finally):
// nessun leak nei test o in produzione.

export type TimeoutErrorFactory = () => Error;

/**
 * Esegue `promise` con un timeout di `ms` millisecondi.
 * Se scade, rigetta con l'errore prodotto da `onTimeout` (il chiamante
 * fornisce l'AppError col codice giusto: E_LLM_TIMEOUT/E_SEARCH_TIMEOUT/...).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: TimeoutErrorFactory,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    // Non tenere il processo vivo per un timer di sola attesa.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      timer.unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
