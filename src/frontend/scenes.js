/* scenes.js: scene guides for the how-to panel. Page script and node module,
 * like bursts.js. Picking a scene shows shooting guidance and what to expect
 * for that kind of shot, and remembers the choice.
 */
function createScenes() {
  'use strict';

  // id, label, one-line pitch, guidance lines, expectation line.
  // Text stays in the app's voice: plain claims, honest limits.
  const SCENES = [
    {
      id: 'landscape',
      label: 'Landscape',
      pitch: 'Tripod or braced, still scene: the best case.',
      tips: [
        'Tripod, or brace the camera. Landscapes hold still, so alignment is easy and the sub-pixel shifts between frames become detail.',
        'RAW with 6 or more frames, at base ISO: the merge runs on the raw sensor samples and picks the sharpening itself.',
        'A millimetre or two of movement between frames is what adds resolution. Pixel-identical frames only denoise, and the app says so.',
        'f/8 to f/11, focus where the detail matters: the merge cannot add detail the lens never resolved.',
        'Waves, clouds and grass gain nothing from any method; Median at least drops them from the merge instead of ghosting.',
      ],
      expect: 'Less noise and cleaner fine edges at 2×, not 4× the detail. Check the split view at 2× zoom before saving.',
      mode: null,
    },
    {
      id: 'night',
      label: 'Night',
      pitch: 'Short frames at lower ISO: merging cuts the noise.',
      tips: [
        'Averaging cuts noise by about the square root of the frame count: 8 frames drop it to roughly a third, around 1.5 stops.',
        'So shoot 8 short frames instead of 1 long one: 8 × 1/4 s at ISO 3200 rather than 2 s at ISO 12800. The merge is as clean as the long exposure, and you can handheld it.',
        'RAW when you can: the raw-sample merge and auto sharpening give the biggest gain for the same effort.',
        'Something moving through frame? Pick Median: it drops movers outright instead of ghosting them.',
        'Keep per-frame ISO moderate. Very high ISO adds banding that is identical in every frame, and averaging cannot remove it.',
      ],
      expect: 'The result is a final JPEG or PNG with your EXIF, not a RAW file to recover further in an editor. <button class="scene-shoot">Shoot a night burst</button>',
      mode: null,
    },
    {
      id: 'handheld',
      label: 'Handheld',
      pitch: 'No tripod: expect denoising more than detail.',
      tips: [
        'Hold the camera against something, exhale, shoot in continuous mode. The app corrects shifts and slight rotation for the whole photo.',
        'Short exposures freeze the wobble better than long ones: at night, raise ISO a little rather than slowing the shutter.',
        'Big movements end up soft. If a photo is badged "Too far off" the app unticks it; keep 4 or more that line up.',
        'Lens parallax limits handheld detail: wide lenses align better than long ones.',
      ],
      expect: 'Handheld bursts mostly buy noise reduction. Any extra detail is a bonus; check the alignment badges after the merge.',
      mode: null,
    },
    {
      id: 'city',
      label: 'City / street',
      pitch: 'Near and far subjects with movement: Median helps, not detail from movers.',
      tips: [
        'Near and far subjects shift parallax between frames; the sub-pixel offsets from slight hand movement become usable detail.',
        'Use a tripod or brace the camera. Slight hand movement still helps, but big shakes soften the merge.',
        'Moving traffic and people ghost if you average. Pick Median: it drops the movers outright instead of smearing them.',
        'Expect denoise and cleaner edges, not detail from moving cars; a car in frame will not resolve into sharp parts.',
      ],
      expect: 'Expect less noise and cleaner fine edges, with movers dropped by Median. No detail is recovered from moving vehicles.',
      mode: null,
    },
    {
      id: 'astro',
      label: 'Astro / night sky',
      pitch: 'Stars on a tripod or tracking mount: denoise, not stacked star detail.',
      tips: [
        'Without a tracking mount, stars trail between frames, so the merge only denoises: the stars will not align as detail.',
        'Shoot short-ish frames at moderate ISO rather than one long frame; avoid very high ISO banding that averaging cannot remove.',
        'Pick Median for satellites and planes crossing the frame; they are movers and will not align.',
        'With a tracking mount the stars hold still and you get the full denoise benefit.',
        'Do not expect stacked star detail the way dedicated astro software does; this merge is for clean files, not a plate-solve replacement.',
      ],
      expect: 'Without a tracking mount the stars only denoise; with one they hold and you get the full benefit. Not a substitute for dedicated astro stacking.',
      mode: null,
    },
  ];

  function byId(id) { return SCENES.find((s) => s.id === id) || null; }

  // HTML for the guide body of one scene (empty string for none).
  function guideHtml(id) {
    const s = byId(id);
    if (!s) return '';
    return '<ul class="scene-tips">' + s.tips.map((t) => '<li>' + t + '</li>').join('') +
      '</ul><p class="scene-expect">' + s.expect + '</p>';
  }

  return { SCENES, byId, guideHtml };
}
if (typeof module === 'object' && module.exports) module.exports = createScenes();
