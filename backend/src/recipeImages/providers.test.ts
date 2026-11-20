import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createImageProvider, normalizeImage } from './providers.js';
import { imageConfig } from './config.js';
const config = { enabled: true, provider: 'openai' as const, apiKey: 'test', model: 'image-test', visionModel: 'vision-test', dailyLimit: 5 };
afterEach(() => vi.unstubAllGlobals());
describe('recipe images', () => {
  it('requires explicit configuration only when enabled', () => {
    expect(imageConfig({}).enabled).toBe(false);
    expect(() => imageConfig({ RECIPE_IMAGES_ENABLED: 'true' })).toThrow();
    expect(imageConfig({ RECIPE_IMAGES_ENABLED: 'true', OPENAI_API_KEY: 'test', RECIPE_IMAGE_MODEL: 'image-test', RECIPE_IMAGE_VISION_MODEL: 'vision-test' }).enabled).toBe(true);
  });
  it('rejects invalid image bytes and normalizes dimensions', async () => {
    await expect(normalizeImage(Buffer.from('not an image'))).rejects.toThrow();
    const input = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const output = await normalizeImage(input);
    expect(output.width).toBe(1024); expect(output.height).toBe(512);
    expect((await sharp(output.bytes).metadata()).format).toBe('webp');
  });
  it('distinguishes an empty search from service failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ batchcomplete: true })));
    expect(await createImageProvider(config).search({ title: 'Pasta', ingredients: [] })).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(createImageProvider(config).search({ title: 'Pasta', ingredients: [] })).rejects.toThrow();
  });
  const cc0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
  const name = 'Pizza_with_mushrooms_and_cheese.jpg';
  const filePath = `/wikipedia/commons/1/16/${name}`;
  const tracking = '?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=';
  const thumbnail = `https://thumb.wikimedia.org/wikipedia/commons/thumb/1/16/${name}/960px-${name}${tracking}thumbnail`;
  const description = `https://commons.wikimedia.org/wiki/File:${name}`;
  const recipe = { title: 'Pasta', ingredients: [{ name: 'private ingredient' }] };
  const image = () => sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toBuffer();
  const commonsFile = (thumburl = thumbnail, license = 'http://creativecommons.org/publicdomain/zero/1.0/deed.en', author = 'LEi - DESIGN', extra = {}, descriptionurl = description) => ({
    pageid: 79703781, ns: 6, title: 'File:Pizza with mushrooms and cheese.jpg', index: 1, imagerepository: 'local', imageinfo: [{
      url: `https://upload.wikimedia.org${filePath}${tracking}original`, thumburl, descriptionurl, thumbwidth: 960, thumbheight: 1440,
      extmetadata: { Artist: { value: author }, LicenseUrl: { value: license }, License: { value: 'cc0' }, LicenseShortName: { value: 'CC0' },
        UsageTerms: { value: 'Creative Commons Zero, Public Domain Dedication' }, AttributionRequired: { value: 'false' }, Restrictions: { value: '' }, ...extra },
    }],
  });
  const batch = (...pages: ReturnType<typeof commonsFile>[]) => ({ batchcomplete: true, query: { pages: pages.map((p, i) => ({ ...p, index: i + 1, pageid: p.pageid + i })) } });
  it('never downloads arbitrary provider URLs or files with unclear licenses', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(batch(commonsFile('http://127.0.0.1/image.jpg'), commonsFile(thumbnail, 'https://example.org/unknown'))));
    vi.stubGlobal('fetch', fetch);
    expect(await createImageProvider(config).search({ title: 'Pasta', ingredients: [] })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([thumbnail, thumbnail.replace('thumb.wikimedia.org', 'upload.wikimedia.org').split('?')[0],
    `https://upload.wikimedia.org${filePath}${tracking}thumbnail_unscaled`])('returns credit for canonical resized or unscaled thumbnail %s', async url => {
    const bytes = await image();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(batch(commonsFile(url))))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'MATCH' } }] }));
    vi.stubGlobal('fetch', fetch);

    expect(await createImageProvider(config).search(recipe)).toMatchObject({
      source: 'wikimedia', author: 'LEi - DESIGN', sourceUrl: description,
      license: cc0, width: 16,
    });
    const [request, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(request).origin).toBe('https://commons.wikimedia.org');
    expect(new URL(request).searchParams.get('gsrsearch')).toContain('Pasta');
    expect(new URL(request).searchParams.get('iiextmetadatafilter')?.split('|')).toContain('License');
    expect(request).not.toContain('private');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(fetch).toHaveBeenNthCalledWith(2, url, expect.objectContaining({ redirect: 'manual' }));
  });
  it('skips BY, BY-SA, lossy credits, special terms and noncanonical file pages', async () => {
    const pages = [commonsFile(thumbnail, 'https://creativecommons.org/licenses/by/4.0/'),
      commonsFile(thumbnail, 'https://creativecommons.org/licenses/by-sa/4.0/'),
      commonsFile(thumbnail, cc0, '<span>A</span> &amp; B'),
      commonsFile(thumbnail, cc0, 'A', { Restrictions: { value: 'trademark' } }),
      commonsFile(thumbnail, cc0, 'A', {}, 'https://commons.wikimedia.org/wiki/File:Pasta.jpg?redirect=no')];
    const fetch = vi.fn().mockImplementation(() => Response.json(batch(...pages)));
    vi.stubGlobal('fetch', fetch);
    await expect(createImageProvider(config).search(recipe)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('binds an escaped UTF-8 filename and literal description comma to the same thumbnail', async () => {
    const page = commonsFile();
    page.title = 'File:Crème brûlée, Tokyo.jpg';
    const encoded = 'Cr%C3%A8me_br%C3%BBl%C3%A9e%2C_Tokyo.jpg';
    const photo = page.imageinfo[0];
    photo.url = photo.url.replace(name, encoded);
    photo.thumburl = photo.thumburl.replaceAll(name, encoded);
    photo.descriptionurl = photo.descriptionurl.replace(name, encoded.replace('%2C', ','));
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(batch(page)))
      .mockResolvedValueOnce(new Response(new Uint8Array(await image())))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'MATCH' } }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(createImageProvider(config).search(recipe)).resolves.toMatchObject({ sourceUrl: photo.descriptionurl });
    expect(fetch).toHaveBeenNthCalledWith(2, photo.thumburl, expect.anything());
  });
  const legacyCredit = () => commonsFile(thumbnail, cc0, 'Test author', { UsageTerms: { value: 'Creative Commons CC0 Waiver' } });
  it.each<[string, (page: ReturnType<typeof commonsFile>) => void]>([
    ['machine license disagrees', p => { p.imageinfo[0].extmetadata.License.value = 'cc-by-sa-4.0'; }],
    ['machine license missing', p => { Reflect.deleteProperty(p.imageinfo[0].extmetadata, 'License'); }],
    ['human license disagrees', p => { p.imageinfo[0].extmetadata.LicenseShortName.value = 'CC BY'; }],
    ['ambiguous machine license', p => { p.imageinfo[0].extmetadata.License.value = 'cc0|cc-by-4.0'; }],
    ['unavailable credit', p => { Reflect.set(p.imageinfo[0], 'extmetadata', []); }],
    ['unavailable credit field', p => { Reflect.deleteProperty(p.imageinfo[0], 'extmetadata'); }],
    ['different title', p => { p.title = 'File:Other.jpg'; }],
    ['different original', p => { p.imageinfo[0].url = p.imageinfo[0].url.replace(name, 'Other.jpg'); }],
    ['different description', p => { p.imageinfo[0].descriptionurl = p.imageinfo[0].descriptionurl.replace(name, 'Other.jpg'); }],
    ['different thumbnail directory', p => { p.imageinfo[0].thumburl = thumbnail.replace(`${name}/`, 'Other.jpg/'); }],
    ['different thumbnail leaf', p => { p.imageinfo[0].thumburl = thumbnail.replace(`960px-${name}`, `960px-Other-${name}`); }],
    ['different shard', p => { p.imageinfo[0].thumburl = thumbnail.replace('/1/16/', '/a/ab/'); }],
    ['double encoded path', p => { p.imageinfo[0].thumburl = thumbnail.replaceAll('_', '%255F'); }],
    ['encoded separator', p => { p.imageinfo[0].thumburl = thumbnail.replace(name, `%2f${name}`); }],
    ['unexpected query', p => { p.imageinfo[0].thumburl += '&width=10'; }],
    ['empty URL fragment', p => { p.imageinfo[0].thumburl += '#'; }],
  ])('skips %s without download or vision', async (_, mutate) => {
    const page = legacyCredit();
    mutate(page);
    const fetch = vi.fn().mockImplementation(() => Response.json(batch(page)));
    vi.stubGlobal('fetch', fetch);
    await expect(createImageProvider(config).search(recipe)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { batchcomplete: true, query: { pages: [{}] } },
    { batchcomplete: false, query: { pages: [] } },
    { batchcomplete: false, continue: { iicontinue: 'partial', continue: '||' }, query: batch(commonsFile()).query },
    { query: batch(commonsFile()).query },
    { batchcomplete: true, continue: { gsroffset: 5, continue: 'gsroffset||' } },
    { ...batch(commonsFile()), continue: { gsroffset: '5', continue: 'gsroffset||' } },
    { ...batch(commonsFile()), warnings: null },
    batch(...Array.from({ length: 6 }, () => commonsFile())),
    { batchcomplete: true, query: { pages: [legacyCredit(), {}] } },
    { batchcomplete: true, query: { pages: [{ ...commonsFile(), index: 0 }] } },
    { batchcomplete: true, query: { pages: [commonsFile(), commonsFile()] } },
    { batchcomplete: true, query: { pages: [{ ...commonsFile(), imageinfo: [] }] } },
    { batchcomplete: true, query: { pages: [{ ...commonsFile(), imageinfo: [null] }] } },
    { batchcomplete: true, query: { pages: [{ ...commonsFile(), imageinfo: [{ thumburl: thumbnail }] }] } },
    { batchcomplete: true, query: { pages: [{ ...commonsFile(), imageinfo: [{ ...commonsFile().imageinfo[0], extmetadata: 'invalid' }] }] } },
    { batchcomplete: true, query: { pages: [commonsFile(), { ...commonsFile('not a URL'), pageid: 2, index: 2 }] } },
  ])('rejects malformed batches before any thumbnail or vision request (case %#)', async body => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(new Response(new Uint8Array(await image())));
    vi.stubGlobal('fetch', fetch);
    await expect(createImageProvider(config).search(recipe)).rejects.toThrow('image_provider_failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses up to five ranked results in a complete batch without requesting the next search page', async () => {
    const first = legacyCredit();
    const pages = batch(first, ...Array.from({ length: 4 }, () => commonsFile(thumbnail.replace('thumb.wikimedia.org', 'upload.wikimedia.org'), cc0, 'Author', { UsageTerms: { value: 'Creative Commons CC0 Waiver' } })));
    pages.query.pages.reverse();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...pages, continue: { gsroffset: 5, continue: 'gsroffset||' } }))
      .mockImplementation(() => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    await expect(createImageProvider(config).search(recipe)).resolves.toBeNull();
    expect(fetch).toHaveBeenNthCalledWith(2, thumbnail, expect.anything());
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  const streamed = (prefix: string, size: number, suffix: string, declared?: string) => {
    let sent = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(Buffer.from(prefix));
        else if (sent <= size) controller.enqueue(Buffer.alloc(4096, 32));
        else { controller.enqueue(Buffer.from(suffix)); controller.close(); }
        sent += 4096;
      }, cancel,
    });
    return { response: new Response(stream, { headers: declared === undefined ? {} : { 'content-length': declared } }), cancel };
  };
  it.each([undefined, '8'])('bounds Commons JSON by actual bytes (length %s)', async declared => {
    const { response, cancel } = streamed('{"batchcomplete":true}', 1024 * 1024, '', declared);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(createImageProvider(config).search(recipe)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('bounds vision and generation JSON before parsing, and rejects oversized base64 before decoding', async () => {
    const vision = streamed('{"choices":[{"message":{"content":"NO"}}]}', 128 * 1024, '', '5');
    const generation = streamed('{"data":[]}', 17 * 1024 * 1024, '');
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(batch(commonsFile())))
      .mockResolvedValueOnce(new Response(new Uint8Array(await image()))).mockResolvedValueOnce(vision.response)
      .mockResolvedValueOnce(generation.response);
    vi.stubGlobal('fetch', fetch);
    await expect(createImageProvider(config).search(recipe)).rejects.toThrow();
    expect(vision.cancel).toHaveBeenCalledTimes(1);
    await expect(createImageProvider(config).generate(recipe)).rejects.toMatchObject({ ambiguous: true });
    expect(generation.cancel).toHaveBeenCalledTimes(1);

    const data = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    fetch.mockResolvedValueOnce(Response.json({ data: [{ b64_json: data }] }));
    const decode = vi.spyOn(Buffer, 'from');
    try {
      await expect(createImageProvider(config).generate(recipe)).rejects.toMatchObject({ ambiguous: true });
      expect((decode.mock.calls as unknown[][]).some(([value, encoding]) => value === data && encoding === 'base64')).toBe(false);
    } finally { decode.mockRestore(); }
  });
  it('skips corrupt, redirected, gone and oversized thumbnails before a valid match', async () => {
    const oversized = streamed('image', 11 * 1024 * 1024, '', '12');
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(batch(...Array.from({ length: 5 }, () => commonsFile()))))
      .mockResolvedValueOnce(new Response('corrupt')).mockResolvedValueOnce(Response.redirect('https://example.org/image'))
      .mockResolvedValueOnce(new Response(null, { status: 410 })).mockResolvedValueOnce(oversized.response)
      .mockResolvedValueOnce(new Response(new Uint8Array(await image())))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'MATCH' } }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(createImageProvider(config).search(recipe)).resolves.toMatchObject({ source: 'wikimedia' });
    expect(oversized.cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(7);
  });
  it.each([429, 503])('treats thumbnail HTTP %s as failure, not an empty result', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(batch(commonsFile())))
      .mockResolvedValueOnce(new Response(null, { status })));
    await expect(createImageProvider(config).search(recipe)).rejects.toThrow();
  });
  it.each(['NO', 'NO.', ' NO ', ''])('only exact vision NO permits fallback (%j)', async content => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(batch(commonsFile())))
      .mockResolvedValueOnce(new Response(new Uint8Array(await image())))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content } }] })));
    const search = createImageProvider(config).search(recipe);
    if (content === 'NO') await expect(search).resolves.toBeNull();
    else await expect(search).rejects.toThrow();
  });
  it('treats Commons maxlag as failure even when it reports a completed batch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ batchcomplete: true, error: { code: 'maxlag' } })));
    await expect(createImageProvider(config).search(recipe)).rejects.toThrow();
  });
  it.each(['openai', 'gemini'] as const)('quarantines ambiguous generation failures for %s', async provider => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(createImageProvider({ ...config, provider }).generate({ title: 'Pasta', ingredients: [] })).rejects.toMatchObject({ ambiguous: true });
  });
  it.each(['openai','gemini'] as const)('decodes generated binary images from %s', async provider => {
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toBuffer();
    const payload = provider === 'openai' ? { data: [{ b64_json: bytes.toString('base64') }] } : { candidates: [{ content: { parts: [{ inlineData: { data: bytes.toString('base64') } }] } }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    const image = await createImageProvider({ ...config, provider }).generate({ title: 'Pasta', ingredients: [] });
    expect(image.source).toBe('ai'); expect(image.width).toBe(16); expect((await sharp(image.bytes).metadata()).format).toBe('webp');
  });

});
