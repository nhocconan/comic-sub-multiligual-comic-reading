package com.tienle.comicsub.reader

object ReaderScripts {
    val discoverCandidates = """
        (() => {
          const selector = 'amp-img, picture img, img';
          const lazyAttrs = ['data-src','data-original','data-lazy-src','data-url','data-image','data-cfsrc','data-echo','data-lazy','data-lazyload','data-ks-lazyload'];
          const exclusion = /(?:^|[\s_-])(avatar|badge|banner|emoji|favicon|icon|logo|recommend|share|sprite|thumb|thumbnail)(?:${'$'}|[\s_-])/i;
          const seen = new Set();
          const all = [];
          const urlFor = (img) => {
            const values = lazyAttrs.map((name) => img.getAttribute(name)).concat([img.currentSrc, img.src]);
            for (const value of values) {
              if (!value) continue;
              try {
                const parsed = new URL(value, document.baseURI);
                if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
              } catch (_) {}
            }
            return null;
          };
          [...document.querySelectorAll(selector)].forEach((raw, ordinal) => {
            const img = raw.tagName === 'IMG' ? raw : raw.querySelector('img');
            if (!img || seen.has(img)) return;
            seen.add(img);
            const rect = img.getBoundingClientRect();
            const width = Math.round(rect.width);
            const height = Math.round(rect.height);
            const area = width * height;
            const aspect = width > 0 ? height / width : 0;
            const signal = [img.id, img.className, img.alt].join(' ');
            const url = urlFor(img);
            if (!url || width < 220 || height < 260 || area < 75000 || aspect < 0.65 || exclusion.test(signal)) return;
            let id = img.dataset.comicSubId;
            if (!id) {
              id = `cs-${'$'}{ordinal}-${'$'}{Math.random().toString(36).slice(2, 9)}`;
              img.dataset.comicSubId = id;
            }
            all.push({
              id,
              url,
              index: all.length,
              width: img.naturalWidth || width,
              height: img.naturalHeight || height,
              top: rect.top,
              bottom: rect.bottom,
              visible: rect.bottom > 0 && rect.top < innerHeight,
              visibleHeight: Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0))
            });
          });
          return JSON.stringify(all.slice(0, 200));
        })()
    """.trimIndent()

    val captureProgress = """
        (() => {
          const images = [...document.querySelectorAll('img[data-comic-sub-id]')];
          if (!images.length) {
            const root = document.scrollingElement || document.documentElement;
            const max = Math.max(1, root.scrollHeight - innerHeight);
            return JSON.stringify({candidateId:'', ordinal:0, intraImageRatio:0, scrollRatio:scrollY/max});
          }
          const middle = innerHeight * 0.42;
          let best = null;
          images.forEach((img, ordinal) => {
            const rect = img.getBoundingClientRect();
            const distance = rect.top <= middle && rect.bottom >= middle
              ? 0 : Math.min(Math.abs(rect.top-middle), Math.abs(rect.bottom-middle));
            if (!best || distance < best.distance) best = {img, ordinal, rect, distance};
          });
          const ratio = Math.max(0, Math.min(1, (middle - best.rect.top) / Math.max(1, best.rect.height)));
          const root = document.scrollingElement || document.documentElement;
          const max = Math.max(1, root.scrollHeight - innerHeight);
          return JSON.stringify({
            candidateId: best.img.dataset.comicSubId || '',
            ordinal: best.ordinal,
            intraImageRatio: ratio,
            scrollRatio: scrollY/max
          });
        })()
    """.trimIndent()

    fun resume(candidateId: String, ordinal: Int, intraImageRatio: Double, fallbackRatio: Double): String {
        val safeId = jsString(candidateId)
        return """
            (() => {
              const images = [...document.querySelectorAll('img[data-comic-sub-id]')];
              const target = images.find((img) => img.dataset.comicSubId === $safeId) || images[$ordinal];
              if (target) {
                const apply = () => {
                  const rect = target.getBoundingClientRect();
                  const y = scrollY + rect.top + rect.height * $intraImageRatio - innerHeight * 0.42;
                  scrollTo({top: Math.max(0,y), behavior:'smooth'});
                };
                if (target.complete) apply(); else target.addEventListener('load', apply, {once:true});
                return 'candidate';
              }
              const root = document.scrollingElement || document.documentElement;
              scrollTo({top: Math.max(0,(root.scrollHeight-innerHeight)*$fallbackRatio), behavior:'smooth'});
              return 'fallback';
            })()
        """.trimIndent()
    }

    fun attachOverlay(candidateId: String, regionsJson: String): String {
        val safeId = jsString(candidateId)
        return """
            (() => {
              const candidateId = $safeId;
              const regions = ($regionsJson).filter(region =>
                region && String(region.translation || '').trim().length > 0
              );
              const img = document.querySelector(`img[data-comic-sub-id="${'$'}{CSS.escape(candidateId)}"]`);
              if (!img) return false;
              let root = document.getElementById('comic-sub-native-overlays');
              if (!root) {
                root = document.createElement('div');
                root.id = 'comic-sub-native-overlays';
                root.setAttribute('aria-label', 'Manga Sub translations');
                root.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,Roboto,sans-serif;';
                document.documentElement.appendChild(root);
              }
              let layer = root.querySelector(`[data-layer-id="${'$'}{CSS.escape(candidateId)}"]`);
              if (!layer) {
                layer = document.createElement('div');
                layer.dataset.layerId = candidateId;
                layer.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;';
                root.appendChild(layer);
              }
              layer.replaceChildren();
              layer.__comicSubRegions = regions;
              const fitText = (box, width, height) => {
                let size = Math.min(
                  box.__comicSubMaxFont || 16,
                  Math.max(8, height * .38),
                );
                box.style.fontSize = `${'$'}{size}px`;
                while (size > 7 && (box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight)) {
                  size -= .5;
                  box.style.fontSize = `${'$'}{size}px`;
                }
              };
              window.__comicSubRenderLayer = (targetLayer, source, targetRegions) => {
                const elementRect = source.getBoundingClientRect();
                const sourceWidth = Math.max(1, source.naturalWidth || elementRect.width);
                const sourceHeight = Math.max(1, source.naturalHeight || elementRect.height);
                const computed = getComputedStyle(source);
                const fit = computed.objectFit;
                let contentWidth = elementRect.width;
                let contentHeight = elementRect.height;
                let offsetX = 0;
                let offsetY = 0;
                if (fit === 'contain' || fit === 'scale-down') {
                  const scale = Math.min(elementRect.width / sourceWidth, elementRect.height / sourceHeight);
                  contentWidth = sourceWidth * scale;
                  contentHeight = sourceHeight * scale;
                  offsetX = (elementRect.width - contentWidth) / 2;
                  offsetY = (elementRect.height - contentHeight) / 2;
                }
                targetLayer.style.left = `${'$'}{elementRect.left + offsetX}px`;
                targetLayer.style.top = `${'$'}{elementRect.top + offsetY}px`;
                targetLayer.style.width = `${'$'}{contentWidth}px`;
                targetLayer.style.height = `${'$'}{contentHeight}px`;
                targetLayer.style.display =
                  elementRect.bottom < 0 || elementRect.top > innerHeight ||
                  elementRect.right < 0 || elementRect.left > innerWidth ? 'none' : 'block';
                const sx = contentWidth / sourceWidth;
                const sy = contentHeight / sourceHeight;
                [...targetLayer.children].forEach((box, index) => {
                  const region = targetRegions[index];
                  if (!region) {
                    box.style.display = 'none';
                    return;
                  }
                  const sourceX = Math.max(0, Math.min(sourceWidth, Number(region.x) || 0));
                  const sourceY = Math.max(0, Math.min(sourceHeight, Number(region.y) || 0));
                  const sourceRegionWidth = Math.max(
                    1,
                    Math.min(sourceWidth - sourceX, Number(region.width) || 1),
                  );
                  const sourceRegionHeight = Math.max(
                    1,
                    Math.min(sourceHeight - sourceY, Number(region.height) || 1),
                  );
                  const sourceLength = Math.max(1, String(region.source || '').replace(/\s/g, '').length);
                  const targetLength = Math.max(1, String(region.translation || '').replace(/\s/g, '').length);
                  const extraLines = Math.min(
                    3,
                    Math.max(1, Math.ceil(targetLength / Math.max(1, sourceLength * 1.55))),
                  );
                  const widthGrowth = targetLength > sourceLength * 1.4 ? 1.4 : 1.12;
                  const grownSourceWidth = Math.min(sourceWidth, sourceRegionWidth * widthGrowth);
                  const maxSourceHeight = Math.min(sourceHeight, sourceRegionHeight * extraLines);
                  const grownSourceX = Math.max(
                    0,
                    Math.min(sourceWidth - grownSourceWidth, sourceX - (grownSourceWidth - sourceRegionWidth) / 2),
                  );
                  const width = Math.max(1, grownSourceWidth * sx);
                  const baseHeight = Math.max(1, sourceRegionHeight * sy);
                  const maxHeight = Math.max(baseHeight, maxSourceHeight * sy);
                  box.style.display = width < 5 || baseHeight < 5 ? 'none' : 'block';
                  box.style.left = `${'$'}{grownSourceX * sx}px`;
                  box.style.width = `${'$'}{width}px`;
                  box.style.height = 'auto';
                  box.style.padding = `${'$'}{Math.min(4, Math.max(1, baseHeight * .06))}px`;
                  const sourceLineCount = Math.max(1, String(region.source || '').split(/\n+/).length);
                  const sourceLineHeight = sourceRegionHeight * sy / sourceLineCount;
                  box.__comicSubMaxFont = Math.min(14, Math.max(8, sourceLineHeight * .9));
                  box.style.fontSize = `${'$'}{box.__comicSubMaxFont}px`;
                  const measuredHeight = box.scrollHeight;
                  const height = Math.min(maxHeight, Math.max(baseHeight, measuredHeight));
                  const grownSourceY = Math.max(
                    0,
                    Math.min(
                      sourceHeight - height / sy,
                      sourceY - ((height - baseHeight) / sy) * .15,
                    ),
                  );
                  box.style.top = `${'$'}{grownSourceY * sy}px`;
                  box.style.height = `${'$'}{height}px`;
                  box.style.display = 'flex';
                  fitText(box, width, height);
                });
              };
              regions.forEach((region) => {
                const box = document.createElement('div');
                box.setAttribute('role','note');
                box.setAttribute('aria-label', `${'$'}{region.source || ''}. Bản dịch: ${'$'}{region.translation || ''}`);
                box.textContent = region.translation || '';
                box.style.cssText = 'position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center;background:rgba(255,253,245,.96);color:#171714;border:1px solid rgba(79,66,38,.24);border-radius:5px;font-weight:650;line-height:1.12;white-space:normal;overflow-wrap:break-word;word-break:normal;overflow:hidden;box-shadow:0 1px 5px rgba(0,0,0,.22);';
                layer.appendChild(box);
              });
              if (!window.__comicSubOverlayBound) {
                window.__comicSubOverlayBound = true;
                let frame = 0;
                const rerender = () => {
                  if (frame) return;
                  frame = requestAnimationFrame(() => {
                    frame = 0;
                  document.querySelectorAll('#comic-sub-native-overlays [data-layer-id]').forEach((item) => {
                    const source = document.querySelector(`img[data-comic-sub-id="${'$'}{CSS.escape(item.dataset.layerId)}"]`);
                    if (!source) { item.remove(); return; }
                    window.__comicSubRenderLayer?.(item, source, item.__comicSubRegions || []);
                  });
                  });
                };
                addEventListener('scroll', rerender, {passive:true});
                addEventListener('resize', rerender, {passive:true});
              }
              window.__comicSubRenderLayer(layer, img, regions);
              return true;
            })()
        """.trimIndent()
    }

    val revealOriginal = """
        (() => {
          const root = document.getElementById('comic-sub-native-overlays');
          if (!root) return false;
          root.hidden = !root.hidden;
          return root.hidden;
        })()
    """.trimIndent()

    val clearOverlays = """
        (() => {
          document.getElementById('comic-sub-native-overlays')?.remove();
          return true;
        })()
    """.trimIndent()

    private fun jsString(value: String): String =
        org.json.JSONObject.quote(value)
}
