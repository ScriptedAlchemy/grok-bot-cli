import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

// Loopback-only credential URLs (src/core/url-policy.js testMode); workers inherit the env.
process.env.GROK_BOT_TEST = '1';

export default defineConfig(await agentBundleRstest());
