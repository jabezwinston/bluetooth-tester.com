// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder examples registry. Example code is kept here, separate from the Bluetooth-Tester
// framework (none of these import framework internals). The Builder seeds from DEFAULT_EXAMPLE
// on first load and offers the rest via the "Reset" menu.

import { media } from './media.js';
import { watch } from './watch.js';
import { nus } from './nus.js';
import { keypad } from './keypad.js';

export const EXAMPLES = [media, watch, nus, keypad];
export const DEFAULT_EXAMPLE = media;
