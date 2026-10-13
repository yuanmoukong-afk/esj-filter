'use strict';
function playwright() { return require('playwright'); }
function launchOptions() { return { headless: true, ...(process.env.ESJ_CHROMIUM ? { executablePath: process.env.ESJ_CHROMIUM } : {}) }; }
module.exports = { playwright, launchOptions };
