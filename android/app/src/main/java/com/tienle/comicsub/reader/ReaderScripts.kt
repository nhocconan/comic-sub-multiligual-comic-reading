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
              visible: rect.bottom > 0 && rect.top < innerHeight
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
              const regions = $regionsJson;
              const img = document.querySelector(`img[data-comic-sub-id="${'$'}{CSS.escape(candidateId)}"]`);
              if (!img) return false;
              let root = document.getElementById('comic-sub-native-overlays');
              if (!root) {
                root = document.createElement('div');
                root.id = 'comic-sub-native-overlays';
                root.setAttribute('aria-label', 'Bản dịch Comic Sub');
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
              const render = () => {
                const rect = img.getBoundingClientRect();
                layer.style.left = `${'$'}{rect.left}px`;
                layer.style.top = `${'$'}{rect.top}px`;
                layer.style.width = `${'$'}{rect.width}px`;
                layer.style.height = `${'$'}{rect.height}px`;
                layer.style.display = rect.bottom < 0 || rect.top > innerHeight ? 'none' : 'block';
                const sx = rect.width / Math.max(1, img.naturalWidth || rect.width);
                const sy = rect.height / Math.max(1, img.naturalHeight || rect.height);
                [...layer.children].forEach((box, i) => {
                  const region = regions[i];
                  box.style.left = `${'$'}{region.x*sx}px`;
                  box.style.top = `${'$'}{region.y*sy}px`;
                  box.style.width = `${'$'}{Math.max(32,region.width*sx)}px`;
                  box.style.minHeight = `${'$'}{Math.max(24,region.height*sy)}px`;
                });
              };
              regions.forEach((region) => {
                const box = document.createElement('div');
                box.setAttribute('role','note');
                box.setAttribute('aria-label', `${'$'}{region.source || ''}. Bản dịch: ${'$'}{region.translation || ''}`);
                box.textContent = region.translation || '';
                box.style.cssText = 'position:absolute;box-sizing:border-box;padding:3px 5px;display:flex;align-items:center;justify-content:center;text-align:center;background:rgba(17,17,15,.95);color:#fff7e5;border:1px solid rgba(230,184,92,.7);border-radius:5px;font-weight:650;font-size:clamp(11px,2.8vw,18px);line-height:1.16;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.45);';
                layer.appendChild(box);
              });
              if (!window.__comicSubOverlayBound) {
                window.__comicSubOverlayBound = true;
                const rerender = () => {
                  document.querySelectorAll('#comic-sub-native-overlays [data-layer-id]').forEach((item) => {
                    const source = document.querySelector(`img[data-comic-sub-id="${'$'}{CSS.escape(item.dataset.layerId)}"]`);
                    if (!source) { item.remove(); return; }
                    const rect = source.getBoundingClientRect();
                    item.style.left = `${'$'}{rect.left}px`;
                    item.style.top = `${'$'}{rect.top}px`;
                    item.style.width = `${'$'}{rect.width}px`;
                    item.style.height = `${'$'}{rect.height}px`;
                    item.style.display = rect.bottom < 0 || rect.top > innerHeight ? 'none' : 'block';
                  });
                };
                addEventListener('scroll', rerender, {passive:true});
                addEventListener('resize', rerender, {passive:true});
              }
              render();
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
