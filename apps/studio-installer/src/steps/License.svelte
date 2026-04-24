<script lang="ts">
  import { store } from "../lib/store.svelte.ts";
  import { advanceStep } from "../lib/installer.ts";

  const LICENSE_TEXT = `FRIDAY STUDIO SOFTWARE LICENSE AGREEMENT

Last updated: 2026-01-01

PLEASE READ THIS LICENSE AGREEMENT CAREFULLY BEFORE INSTALLING OR USING FRIDAY STUDIO.

1. GRANT OF LICENSE

Tempest Labs, Inc. ("Tempest") grants you a limited, non-exclusive, non-transferable, revocable license to install and use Friday Studio solely for your personal, non-commercial purposes on devices that you own or control.

2. RESTRICTIONS

You may not:
(a) copy, modify, or distribute Friday Studio;
(b) reverse engineer, decompile, disassemble, or attempt to derive the source code of Friday Studio;
(c) sell, transfer, assign, or sublicense your rights in Friday Studio to any other party;
(d) remove or alter any proprietary notices or labels on Friday Studio;
(e) use Friday Studio for any unlawful purpose or in violation of any applicable laws or regulations.

3. INTELLECTUAL PROPERTY

Friday Studio and all copies thereof are proprietary to Tempest and title thereto remains in Tempest. All rights in Friday Studio not specifically granted herein are reserved to Tempest.

4. PRIVACY

Friday Studio processes your AI API keys locally on your device. Your keys are stored in your local home directory (~/.friday/local/.env) and are not transmitted to Tempest servers.

5. DISCLAIMER OF WARRANTIES

FRIDAY STUDIO IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. TO THE MAXIMUM EXTENT PERMITTED BY LAW, TEMPEST DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.

6. LIMITATION OF LIABILITY

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL TEMPEST BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING OUT OF OR RELATED TO YOUR USE OF OR INABILITY TO USE FRIDAY STUDIO.

7. TERMINATION

This license is effective until terminated. Your rights under this license will terminate automatically without notice from Tempest if you fail to comply with any of its terms.

8. GOVERNING LAW

This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without giving effect to any principles of conflicts of law.

9. ENTIRE AGREEMENT

This Agreement constitutes the entire agreement between you and Tempest relating to Friday Studio and supersedes all prior or contemporaneous oral or written communications, proposals, and representations with respect to Friday Studio.

By clicking "Accept", you acknowledge that you have read this Agreement, understand it, and agree to be bound by its terms.`;

  function onScroll(e: Event) {
    const el = e.target as HTMLDivElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 5) {
      store.licenseScrolledToBottom = true;
    }
  }

  function accept() {
    store.licenseAccepted = true;
    advanceStep();
  }
</script>

<div class="screen">
  <div class="header">
    <h2>License Agreement</h2>
    <p class="hint">Please scroll to the bottom to continue</p>
  </div>

  <div class="license-scroll" role="region" aria-label="License text" onscroll={onScroll}>
    <pre class="license-text">{LICENSE_TEXT}</pre>
  </div>

  <div class="footer">
    <button
      class="primary"
      disabled={!store.licenseScrolledToBottom}
      onclick={accept}
    >
      Accept &amp; Continue
    </button>
    {#if !store.licenseScrolledToBottom}
      <span class="scroll-hint">Scroll to read the full agreement</span>
    {/if}
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: 0;
  }

  .header {
    padding: 28px 32px 16px;
    flex-shrink: 0;
  }

  h2 {
    font-size: 20px;
    font-weight: 700;
    color: #f0f0f0;
    margin-bottom: 4px;
  }

  .hint {
    font-size: 12px;
    color: #666;
  }

  .license-scroll {
    flex: 1;
    overflow-y: scroll;
    margin: 0 32px;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    background: #131313;
    padding: 20px;
  }

  .license-text {
    font-family: monospace;
    font-size: 12px;
    line-height: 1.6;
    color: #aaa;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .footer {
    padding: 20px 32px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }

  button {
    padding: 10px 28px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }

  .primary {
    background: #6b72f0;
    color: #fff;
  }

  .primary:hover:not(:disabled) {
    background: #5a62e0;
  }

  .primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .scroll-hint {
    font-size: 12px;
    color: #555;
  }
</style>
