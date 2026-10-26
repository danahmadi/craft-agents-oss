/**
 * Cross-platform resources copy script
 */

import { copyElectronResources } from './electron-resources.ts';
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
copyElectronResources(ROOT_DIR);
console.log('📦 Copied resources and rebuilt session helper to dist');
