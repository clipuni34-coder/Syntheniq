#!/usr/bin/env node
// Generate (or refresh, if cached) the synthetic test/demo media.
import { ensureFixtures } from '../test/helpers/fixtures.js';

const out = ensureFixtures();
console.log('demo :', out.demo);
console.log('short:', out.short);
