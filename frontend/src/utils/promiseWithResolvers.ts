/**
 * `Promise.withResolvers`, for a browser that does not have it yet.
 *
 * pdf.js calls it everywhere, and its legacy build - which fills in every
 * other new built-in it uses - leaves this one out. iPhones before iOS 17.4
 * and Chrome before 119 lack it, so without this the PDF preview failed on
 * exactly the older phones the legacy build is there for. Imported by
 * `pdfjs.ts` before pdf.js itself, so it is in place when pdf.js loads.
 */
type WithResolvers = <T>() => {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

const PromiseCtor = Promise as unknown as { withResolvers?: WithResolvers }

if (typeof PromiseCtor.withResolvers !== 'function') {
  PromiseCtor.withResolvers = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

export {}
