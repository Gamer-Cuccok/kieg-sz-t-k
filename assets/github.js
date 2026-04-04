(() => {
  const API = "https://api.github.com";

  // cache: gyorsabb mentés + sha hiány hiba elkerülése
  const shaCache = new Map();
  const cacheKey = ({ owner, repo, branch, path }) =>
    `${owner}/${repo}@${branch}:${String(path || "")}`;

  function encodePath(path){
    return String(path || "")
      .split("/")
      .map(seg => encodeURIComponent(seg))
      .join("/");
  }

  function toBase64Unicode(str){
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  function fromBase64Unicode(b64){
    if(!b64) return "";
    const bin = atob(b64);
    const bytes = new Uint8Array([...bin].map(ch => ch.charCodeAt(0)));
    return new TextDecoder().decode(bytes);
  }

  async function ghRequest(token, method, url, body){
    const headers = {
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    };
    if(token) headers["Authorization"] = `token ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      cache: "no-store",
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if(!res.ok){
      const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      err.url = url;
      throw err;
    }
    return data;
  }

  async function getFile({token, owner, repo, path, branch}){
    const url = `${API}/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`;
    const data = await ghRequest(token, "GET", url);
    const content = fromBase64Unicode(data.content || "");
    const sha = data.sha || null;
    try{
      shaCache.set(cacheKey({owner, repo, branch, path}), sha);
    }catch{}
    return { sha, content };
  }

  async function putFile({token, owner, repo, path, branch, message, content, sha}){
    const url = `${API}/repos/${owner}/${repo}/contents/${encodePath(path)}`;
    const body = {
      message: message || `Update ${path}`,
      content: toBase64Unicode(content || ""),
      branch
    };
    if(sha) body.sha = sha;

    const res = await ghRequest(token, "PUT", url, body);

    // update cache
    const newSha = res?.content?.sha || null;
    if(newSha){
      try{
        shaCache.set(cacheKey({owner, repo, branch, path}), newSha);
      }catch{}
    }
    return res;
  }

  async function putFileSafe({token, owner, repo, path, branch, message, content, sha, retries=3}){
    let curSha = sha || null;

    // ha nem adtak sha-t, próbáljuk cache-ből (gyors)
    if(!curSha){
      try{
        const cached = shaCache.get(cacheKey({owner, repo, branch, path}));
        if(cached) curSha = cached;
      }catch{}
    }

    let lastErr = null;

    for(let i=0;i<=retries;i++){
      try{
        return await putFile({token, owner, repo, path, branch, message, content, sha: curSha});
      }catch(e){
        lastErr = e;
        const msg = String(e?.message || "");
        const status = Number(e?.status || 0);

        const shaMissing = status === 422 && /sha/i.test(msg);
        const retryable = shaMissing || status === 409 || msg.includes("does not match") || msg.includes("expected");

        if(i < retries && retryable){
          await new Promise(r => setTimeout(r, 200 + Math.random()*200));

          // sha hiány / konflikt: kérjük le a legfrissebbet és próbáljuk újra
          try{
            const latest = await getFile({token, owner, repo, path, branch});
            curSha = latest.sha || null;
            continue;
          }catch(fetchErr){
            // ha nem létezik, próbáljuk létrehozni sha nélkül
            if(Number(fetchErr?.status || 0) === 404){
              curSha = null;
              continue;
            }
            throw e;
          }
        }
        throw e;
      }
    }
    throw lastErr || new Error("Mentés hiba");
  }

  window.ShadowGH = { getFile, putFile, putFileSafe };
})();
