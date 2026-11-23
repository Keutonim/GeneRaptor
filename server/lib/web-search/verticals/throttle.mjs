/**
 * Request throttler of the verticals.
 *
 * Some free providers publish a hard rate limit that a violated client gets
 * blocked for (Nominatim: 1 request per second, absolute maximum; OpenLibrary:
 * 1 request per second without identification). The throttler keeps the
 * client inside the published limit instead of hoping for the best.
 *
 * The clock and the sleep function are injectable: the unit tests never wait
 * for a real second.
 */

/**
 * @param {number} minIntervalMs minimal interval between two requests
 * @returns {((options?: {now?: Function, sleep?: Function}) => Promise<void>) & {reset: () => void}}
 */
export function createThrottle(minIntervalMs) {
  let last = 0;

  const throttle = async (options = {}) => {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
    const current = now();
    if (last !== 0) {
      const wait = minIntervalMs - (current - last);
      if (wait > 0) await sleep(wait);
    }
    last = now();
  };

  throttle.reset = () => {
    last = 0;
  };

  return throttle;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
