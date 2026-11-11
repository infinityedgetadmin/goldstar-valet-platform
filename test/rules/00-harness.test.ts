import { it } from 'vitest';
import { anon, assertFails } from './helpers';
import { doc, getDoc } from 'firebase/firestore';
it('harness boots and denies by default', async () => { await assertFails(getDoc(doc(anon(), 'operators/goldstar'))); });
