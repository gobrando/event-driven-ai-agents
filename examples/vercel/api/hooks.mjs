import { createReceiver } from '../src/receiver.mjs';
import { createLiveRuntime } from '../src/runtime.mjs';

let runtimePromise;
const endpoint = {
  async fetch(request) {
    try {
      runtimePromise ??= createLiveRuntime().catch(error => { runtimePromise = undefined; throw error; });
      const { store, queue, config } = await runtimePromise;
      return createReceiver({ store, queue, verifierOptions: config.verifier })(request);
    } catch {
      return new Response(null, { status: 503 });
    }
  },
};

export default endpoint;
