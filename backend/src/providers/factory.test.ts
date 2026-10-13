import { describe, expect, it, vi } from 'vitest';
import { createProviders } from './factory.js';
import type { SmtpTransportFactory } from './smtp.js';

describe('createProviders', () => {
  it('returns a typed unavailable error without provider credentials', async () => {
    const providers = createProviders({ providers: {} });

    await expect(providers.nutrition.lookup({ query: 'tomato' })).rejects.toMatchObject({
      code: 'provider_unavailable',
      provider: 'nutrition',
    });
  });

  it('exposes all provider ports without performing network work', async () => {
    const providers = createProviders({ providers: {} });

    await expect(providers.email.send({
      to: 'person@example.com',
      subject: 'Verification',
      html: '<p>Verify</p>',
    })).rejects.toMatchObject({ provider: 'email' });
    await expect(providers.recipes.generate({
      ingredients: ['tomato'],
      constraints: [],
    })).rejects.toMatchObject({ provider: 'recipes' });
  });

  it('selects the USDA adapter only when an API key is configured', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      foods: [{ description: 'Tomato', foodNutrients: [{ nutrientId: 1008, value: 18 }] }],
    })));
    const providers = createProviders({ providers: { usdaApiKey: 'test-key' } }, { fetch });

    await expect(providers.nutrition.lookup({ query: 'tomato' })).resolves.toMatchObject({ source: 'usda', calories: 18 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('selects the OpenAI recipe adapter only when its API key is configured', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify({
      title: 'Ceci croccanti', description: 'Ricetta semplice.', ingredients: [{ name: 'Ceci', amount: '240 g' }],
      steps: ['Scola i ceci.'], diets: ['vegan'], allergens: [],
    }) })));
    const providers = createProviders({ providers: { openAiApiKey: 'test-key', openAiModel: 'gpt-5.5' } }, { fetch });

    await expect(providers.recipes.generate({ ingredients: ['Ceci'], constraints: [] })).resolves.toMatchObject({ title: 'Ceci croccanti' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('selects the Gemini recipe adapter when configured', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      title: 'Ceci croccanti', description: 'Ricetta semplice.', ingredients: [{ name: 'Ceci', amount: '240 g' }],
      steps: ['Scola i ceci.'], diets: ['vegan'], allergens: [],
    }) }] } }] })));
    const providers = createProviders({ providers: { recipeProvider: 'gemini', geminiApiKey: 'gemini-test-key', geminiModel: 'gemini-test' } }, { fetch });

    await expect(providers.recipes.generate({ ingredients: ['Ceci'], constraints: [] })).resolves.toMatchObject({ title: 'Ceci croccanti' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the selected Gemini provider for dinner reconstruction without requiring OpenAI credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ recipes: [] }) }] } }],
    })));
    const providers = createProviders({ providers: {
      recipeProvider: 'gemini',
      geminiApiKey: 'test-gemini-key',
      geminiModel: 'gemini-dinner-test',
    } }, { fetch });

    await expect(providers.dinnerReconstruction.reconstruct({ dinnerText: 'Pasta', servings: null })).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-dinner-test:generateContent');
  });

  it('does not fall back to OpenAI when Gemini is selected but Gemini is unconfigured', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify({ recipes: [] }) })));
    const providers = createProviders({ providers: {
      recipeProvider: 'gemini',
      openAiApiKey: 'test-openai-key',
    } }, { fetch });

    await expect(providers.dinnerReconstruction.reconstruct({ dinnerText: 'Pasta', servings: null })).rejects.toMatchObject({
      code: 'provider_unavailable', provider: 'dinner_reconstruction',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('selects OpenAI dinner reconstruction only when OpenAI is selected', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify({ recipes: [] }) })));
    const providers = createProviders({ providers: {
      recipeProvider: 'openai',
      openAiApiKey: 'test-openai-key',
      openAiModel: 'gpt-5.5',
      geminiApiKey: 'test-gemini-key',
    } }, { fetch });

    await expect(providers.dinnerReconstruction.reconstruct({ dinnerText: 'Pasta', servings: null })).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
  });

  it('keeps the email provider unavailable when no SMTP configuration is present', async () => {
    const createTransport = vi.fn();
    const providers = createProviders({ providers: {} }, { createTransport: createTransport as unknown as SmtpTransportFactory });

    await expect(providers.email.send({
      to: 'person@example.com',
      subject: 'Verification',
      html: '<p>Verify</p>',
    })).rejects.toMatchObject({
      code: 'provider_unavailable', provider: 'email', reason: 'missing_configuration',
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('keeps the email provider unavailable when only part of the SMTP configuration is present', async () => {
    const createTransport = vi.fn();
    const options = { createTransport: createTransport as unknown as SmtpTransportFactory };

    const hostOnly = createProviders({ providers: { smtpHost: 'smtp.example' } }, options);
    await expect(hostOnly.email.send({ to: 'person@example.com', subject: 'Verify', html: '<p>Verify</p>' }))
      .rejects.toMatchObject({ code: 'provider_unavailable', reason: 'adapter_not_enabled' });

    const userWithoutPassword = createProviders({ providers: {
      smtpHost: 'smtp.example',
      smtpUser: 'smtp-user',
      emailFrom: 'no-reply@ikuck.example',
    } }, options);
    await expect(userWithoutPassword.email.send({ to: 'person@example.com', subject: 'Verify', html: '<p>Verify</p>' }))
      .rejects.toMatchObject({ code: 'provider_unavailable', reason: 'missing_configuration' });

    expect(createTransport).not.toHaveBeenCalled();
  });

  it('selects the SMTP adapter when host, sender and credentials are configured', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'smtp-1' });
    const createTransport = vi.fn(() => ({ sendMail }));
    const providers = createProviders({ providers: {
      smtpHost: 'smtp.example',
      smtpPort: 587,
      smtpUser: 'smtp-user',
      smtpPass: 'app-pass',
      emailFrom: 'no-reply@ikuck.example',
    } }, { createTransport: createTransport as unknown as SmtpTransportFactory });

    await expect(providers.email.send({ to: 'person@example.com', subject: 'Verify', html: '<p>Verify</p>' }))
      .resolves.toEqual({ messageId: 'smtp-1' });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.example',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'smtp-user', pass: 'app-pass' },
    }));
    expect(sendMail).toHaveBeenCalledWith({
      from: 'no-reply@ikuck.example',
      to: 'person@example.com',
      subject: 'Verify',
      html: '<p>Verify</p>',
    });
  });

  it('selects the SMTP adapter for an unauthenticated relay on the implicit TLS port', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'smtp-2' });
    const createTransport = vi.fn(() => ({ sendMail }));
    const providers = createProviders({ providers: {
      smtpHost: 'smtp.example',
      smtpPort: 465,
      emailFrom: 'no-reply@ikuck.example',
    } }, { createTransport: createTransport as unknown as SmtpTransportFactory });

    await expect(providers.email.send({ to: 'person@example.com', subject: 'Verify', html: '<p>Verify</p>' }))
      .resolves.toEqual({ messageId: 'smtp-2' });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      port: 465,
      secure: true,
      requireTLS: false,
      auth: undefined,
    }));
  });
});
