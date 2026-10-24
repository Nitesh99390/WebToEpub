"use strict";

parserFactory.register("wtr-lab.com", () => new WtrlabParser());

class WtrlabParser extends Parser {
    constructor() {
        super();
        this.minimumThrottle = 12000;
        this.termsuser = [];
        this.termsstory = [];
        this.slug = "";
        this.img = null;
        this.serieData = null;
        this.encryptionKey = null;
    }

    populateUIImpl() {
        document.getElementById("removeChapterNumberRow").hidden = false; 
        // raw download no longer supported as the raw text is encoded and i don't know how.
        // leaving old code in case it gets solved.
        // document.getElementById("selectTranslationAiRow").hidden = false;
        document.getElementById("selectRetryLongerRow").hidden = false;  
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    /**
     * Extract language, novel id and slug from any wtr-lab url.
     * Supports:
     *   https://wtr-lab.com/en/novel/86878/some-slug?tab=toc
     *   https://wtr-lab.com/en/novel/86878/some-slug/chapter-12
     *   https://wtr-lab.com/en/serie-86878/some-slug
     */
    static parseNovelUrl(url) {
        let path = new URL(url).pathname;
        let match = path.match(/^\/([^/]+)\/(?:novel\/|serie-)(\d+)(?:\/([^/?#]+))?(?:\/chapter-(\d+))?/);
        if (match == null) {
            return null;
        }
        return {
            language: match[1],
            id: match[2],
            slug: match[3] ?? "",
            chapter: match[4] ?? null
        };
    }

    /**
     * wtr-lab hides some words ("debranding") as %{safe|base64} or %{"safe":"base64"}.
     * Replace them with the decoded text (or the safe text as fallback).
     */
    static resolveTokens(str) {
        if (str == null) {
            return "";
        }
        return String(str).replace(
            /%\{(?:"([^"]*)":\s*"?([A-Za-z0-9+/=_-]+)"?|([^|{}%\u0000-\u001F\u007F\u2028\u2029]+?)\s*\|\s*([A-Za-z0-9+/=_-]+))\}/g, // eslint-disable-line no-control-regex
            (match, safe1, b64a, safe2, b64b) => {
                let safe = (safe1 ?? safe2 ?? "").trim();
                let decoded = WtrlabParser.decodeBase64Utf8((b64a ?? b64b ?? "").trim());
                return decoded || safe || match;
            }
        );
    }

    static decodeBase64Utf8(b64) {
        try {
            let clean = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
            if (!/^[A-Za-z0-9+/]*$/.test(clean) || (clean.length % 4 === 1)) {
                return "";
            }
            let padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
            let bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
            return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
        } catch {
            return "";
        }
    }

    static getNextData(dom) {
        let text = dom?.querySelector("script#__NEXT_DATA__")?.textContent;
        if (!text) {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    async fetchNovelPage(dom) {
        // The page the user has open might be stale, a chapter page or missing __NEXT_DATA__.
        try {
            let fresh = (await HttpClient.wrapFetch(dom.baseURI)).responseXML;
            if (WtrlabParser.getNextData(fresh) != null) {
                return fresh;
            }
        } catch (error) {
            util.log(error);
        }
        return dom;
    }

    static absoluteUrl(url) {
        if (!url) {
            return "";
        }
        if (url.startsWith("//")) {
            return "https:" + url;
        }
        return new URL(url, "https://wtr-lab.com/").href;
    }

    // ---------------------------------------------------------------------
    // table of contents
    // ---------------------------------------------------------------------

    async getChapterUrls(dom) {
        let info = WtrlabParser.parseNovelUrl(dom.baseURI);
        if (info == null) {
            throw new Error("Could not find the novel id in URL '" + dom.baseURI + "'. Open the novel page (wtr-lab.com/en/novel/<id>/<name>) and try again.");
        }
        let tocHtml = await this.fetchNovelPage(dom);
        let serie = WtrlabParser.getNextData(tocHtml)?.props?.pageProps?.serie;
        let language = info.language;
        let id = info.id;
        let slug = info.slug || serie?.serie_data?.slug || "";
        this.slug = slug;

        let chapters = await this.fetchAllChapters(id);
        if (chapters.length === 0) {
            throw new Error("wtr-lab returned an empty chapter list for novel " + id + ".");
        }
        let serie_id = chapters[0].serie_id ?? serie?.serie_data?.id;
        await this.loadTerms(id, serie_id);

        let removeNumber = document.getElementById("removeChapterNumberCheckbox")?.checked;
        return chapters.map(a => {
            let title = WtrlabParser.resolveTokens(a.title || a.name || ("Chapter " + a.order));
            return {
                sourceUrl: "https://wtr-lab.com/" + language + "/novel/" + id + "/" + slug + "/chapter-" + a.order,
                title: removeNumber ? title : a.order + ": " + title
            };
        });
    }

    /**
     * /api/chapters/<id> without a range only returns the first ~300 chapters
     * and a very large range returns HTTP 500, so fetch the list in batches.
     */
    async fetchAllChapters(id) {
        const batchSize = 500;
        let all = [];
        let seen = new Set();
        for (let start = 1; ; start += batchSize) {
            let end = start + batchSize - 1;
            let url = "https://wtr-lab.com/api/chapters/" + id + "?start=" + start + "&end=" + end;
            let batch;
            try {
                let json = (await HttpClient.fetchJson(url)).json;
                batch = json?.chapters ?? json?.data?.chapters ?? [];
            } catch (error) {
                if (start === 1) {
                    // older API behaviour: no paging support
                    let json = (await HttpClient.fetchJson("https://wtr-lab.com/api/chapters/" + id)).json;
                    batch = json?.chapters ?? [];
                    all = batch;
                    break;
                }
                throw error;
            }
            if (!Array.isArray(batch) || batch.length === 0) {
                break;
            }
            let added = 0;
            for (let chapter of batch) {
                if (!seen.has(chapter.order)) {
                    seen.add(chapter.order);
                    all.push(chapter);
                    added++;
                }
            }
            // stop if the server ignored the range (would loop forever) or this was the last batch
            if (added === 0 || batch.length < batchSize) {
                break;
            }
        }
        return all.sort((a, b) => a.order - b.order);
    }

    async loadTerms(id, serie_id) {
        this.termsuser = [];
        this.termsstory = [];
        // user defined terms (only available when logged in)
        try {
            let terms = (await HttpClient.fetchJson("https://wtr-lab.com/api/v2/user/config")).json;
            terms = (terms?.config?.terms ?? []).filter(a => (a[4] == null) || (a[4].includes(serie_id)));
            for (let term of terms) {
                let to = term[1];
                for (let from of String(term[2] ?? "").split("|")) {
                    if (from !== "" && to != null) {
                        this.termsuser.push({from: from, to: to});
                    }
                }
            }
        } catch (error) {
            this.termsuser = [];
        }
        //entire stories have their own terms that superseed the chapter ones
        try {
            let terms = (await HttpClient.fetchJson("https://wtr-lab.com/api/v2/reader/terms/" + id + ".json")).json;
            let termstmp = {};
            for (let glossary of terms?.glossaries ?? []) {
                for (let term of glossary?.data?.terms ?? []) {
                    let to = Array.isArray(term?.[0]) ? term[0][0] : term?.[0];
                    if (term?.length > 1 && term[1] && to) {
                        termstmp[term[1]] = to;
                    }
                }
            }
            for (let key in termstmp) {
                this.termsstory.push({from: key, to: termstmp[key]});
            }
        } catch (error) {
            this.termsstory = [];
        }
    }

    // ---------------------------------------------------------------------
    // metadata
    // ---------------------------------------------------------------------

    async loadEpubMetaInfo(dom) {
        let tocHtml = await this.fetchNovelPage(dom);
        let serie = WtrlabParser.getNextData(tocHtml)?.props?.pageProps?.serie;
        this.serieData = serie?.serie_data?.data ?? null;
        this.img = this.serieData?.image ?? null;
    }

    formatTitle(link) {
        let span = link.querySelector("span").textContent.trim();
        let num = link.querySelector("b").textContent.trim().replace("#", "");
        return num + ": " + span;
    }

    findContent(dom) {
        return Parser.findConstructedContent(dom);
    }

    extractTitleImpl(dom) {
        let title = this.serieData?.title;
        if (title) {
            return WtrlabParser.resolveTokens(title);
        }
        let h1 = dom.querySelector("h1");
        if (h1 != null) {
            return WtrlabParser.resolveTokens(h1.textContent);
        }
        return null;
    }

    findCoverImageUrl() {
        return this.img;
    }

    extractSubject(dom) {
        let tagsgenre = [...dom.querySelectorAll("span.genre")].map(a => a.textContent);
        let tagstags = [...dom.querySelectorAll(".tags a.tag")].map(a => a.textContent.replace(",", ""));
        let tags = tagsgenre;
        tags = tags.concat(tagstags);
        return tags.map(e => WtrlabParser.resolveTokens(e.trim())).join(", ");
    }

    extractDescription(dom) {
        let desc = dom.querySelector("span.description")?.textContent?.trim();
        if (!desc) {
            desc = this.serieData?.description ?? "";
        }
        return WtrlabParser.resolveTokens(desc).trim();
    }

    getInformationEpubItemChildNodes(dom) {
        return [...dom.querySelectorAll("div#contents-tabpane-about")];
    }

    extractAuthor(dom) {
        let spans = [...dom.querySelectorAll("span")];
        let authorSpan = spans.find(span => span.textContent.trim() === "Author");
        if (authorSpan && authorSpan.nextElementSibling) {
            let links = [...authorSpan.nextElementSibling.querySelectorAll("a")];
            if (links.length > 0) {
                return links.map(link => WtrlabParser.resolveTokens(link.textContent.trim())).join(" - ");
            }
        }
        if (this.serieData?.author) {
            return WtrlabParser.resolveTokens(this.serieData.author);
        }
        return super.extractAuthor(dom);
    }

    // ---------------------------------------------------------------------
    // chapters
    // ---------------------------------------------------------------------

    async fetchChapter(url) {
        let info = WtrlabParser.parseNovelUrl(url);
        let fetchUrl = "https://wtr-lab.com/api/reader/get";
        let formData = 
            {
                "translate": "ai",
                "language": info.language,
                "raw_id": parseInt(info.id),
                "chapter_no": parseInt(info.chapter),
                "retry": false,
                "force_retry": false
            };
        let header = {"Content-Type": "application/json;charset=UTF-8", "Accept": "application/json"};
        let options = {
            method: "POST",
            body: JSON.stringify(formData),
            headers: header,
            credentials: "include",
            parser: this
        };
        let json = (await HttpClient.fetchJson(fetchUrl, options)).json;
        let content = await this.resolveChapterContent(json);
        if (WtrlabParser.isEncrypted(content.body)) {
            content.body = await this.decryptBody(content.body, url);
        }
        return this.buildChapter({data: {data: content}, chapter: json?.chapter}, url);
    }

    /**
     * The reader API used to return the chapter inline at data.data,
     * now it (usually) returns a content_url pointing to the real payload.
     * Handle both.
     */
    async resolveChapterContent(json) {
        let inline = json?.data?.data;
        if (inline?.body !== undefined) {
            return inline;
        }
        let contentUrl = json?.content_url;
        if (!contentUrl) {
            throw new Error("wtr-lab did not return any chapter content.");
        }
        let target = WtrlabParser.absoluteUrl(contentUrl);
        let contentjson = (await HttpClient.fetchJson(target)).json;
        let payload = contentjson?.data?.data ?? contentjson?.data ?? contentjson;
        if (payload?.body === undefined) {
            throw new Error("wtr-lab returned chapter content in an unknown format (" + target + ").");
        }
        return payload;
    }

    static isEncrypted(body) {
        return (typeof body === "string") && (body.startsWith("arr:") || body.startsWith("str:"));
    }

    async getEncryptionKey(url) {
        if (this.encryptionKey) {
            return this.encryptionKey;
        }
        const searchKey = "TextEncoder().encode(\"";
        let page = (await HttpClient.wrapFetch(url)).responseXML;
        let scripts = [...new Set([...page.querySelectorAll("script[src]")].map(s => s.getAttribute("src")))];
        for (let src of scripts) {
            try {
                let code = await HttpClient.fetchText(WtrlabParser.absoluteUrl(src));
                let index = code.indexOf(searchKey);
                if (0 <= index) {
                    this.encryptionKey = code.substring(index + searchKey.length, index + searchKey.length + 32);
                    return this.encryptionKey;
                }
            } catch (error) {
                util.log(error);
            }
        }
        throw new Error("wtr-lab sent an encrypted chapter and the decryption key could not be found.");
    }

    async decryptBody(encrypted, url) {
        let isArray = encrypted.startsWith("arr:");
        let parts = encrypted.substring(4).split(":");
        if (parts.length !== 3) {
            throw new Error("wtr-lab sent an encrypted chapter in an unknown format.");
        }
        let [iv, tag, ciphertext] = parts.map(p => Uint8Array.from(atob(p), c => c.charCodeAt(0)));
        let combined = new Uint8Array(ciphertext.length + tag.length);
        combined.set(ciphertext);
        combined.set(tag, ciphertext.length);
        let keyText = await this.getEncryptionKey(url);
        let key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyText.slice(0, 32)), {name: "AES-GCM"}, false, ["decrypt"]);
        let plain = new TextDecoder().decode(await crypto.subtle.decrypt({name: "AES-GCM", iv: iv}, key, combined));
        return isArray ? JSON.parse(plain) : plain.split("\n");
    }
    
    isCustomError(response) {
        let json = response?.json;
        if (json == null) {
            return true;
        }
        if (json.code == "CHAPTER_LOCKED" || json.requireTurnstile || json.code == 1401) {
            return true;
        }
        // chapter content is either inline or behind content_url
        return !(json.content_url || (json.data?.data?.body !== undefined));
    }

    setCustomErrorResponse(url, wrapOptions, checkedresponse) {
        let json = checkedresponse.json ?? {};
        let newresp = {};
        newresp.url = url;
        newresp.wrapOptions = wrapOptions;
        newresp.response = {};
        newresp.response.url = this.PostToUrl(checkedresponse.response.url, JSON.parse(wrapOptions.fetchOptions.body));
        if (json.code == "CHAPTER_LOCKED") {
            newresp.response.status = 999;
            newresp.response.retryDelay = [];
            newresp.errorMessage = "Fetch of URL '" + newresp.response.url + "' failed.\nThe Chapter isn't Ai translated.";
            return newresp;
        }
        if (json.requireTurnstile || json.code == 1401) {
            newresp.response.status = 403;
            return newresp;
        }
        newresp.response.status = 999;
        if (document.getElementById("selectRetryLongerCheckbox")?.checked) {
            newresp.response.retryDelay = [80,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120];
        } else {
            newresp.response.retryDelay = [80,40,25,25,25];
        }
        let serverMessage = json.error || json.message;
        newresp.errorMessage = "Fetch of URL '" + newresp.response.url + "' failed.\n" +
            (serverMessage ? "Server message: " + serverMessage + "\n" : "") +
            "The server sends an empty Chapter try to open the URL and try again if you can see the Chapter on the normal website.\nIt could also be that you try to get an Ai translated novel that isn't Ai tranlated.";
        return newresp;
    }

    PostToUrl(url, body) {
        let hostname = new URL(url).hostname;
        let translate = body.translate;
        let language = body.language;
        let raw_id = body.raw_id;
        let chapter_no = body.chapter_no;
        return "https://" + hostname + "/" + language + "/novel/" + raw_id + "/" + this.slug + "/chapter-" + chapter_no + "?service=" + translate;
    }

    buildChapter(json, url) {
        let chapter = WtrlabParser.parseNovelUrl(url)?.chapter ?? "";
        let data = json?.data?.data ?? {};
        let glossary = this.buildGlossary(data);
        let newDoc = Parser.makeEmptyDocForContent(url);
        let title = newDoc.dom.createElement("h1");
        let rawTitle = data.title || json?.chapter?.title || ("Chapter " + chapter);
        let removeNumber = document.getElementById("removeChapterNumberCheckbox")?.checked;
        title.textContent = this.replaceTextWithCustomTerms(data, (removeNumber ? "" : chapter + ": ") + rawTitle, glossary);
        newDoc.content.appendChild(title);

        let images = Array.isArray(data.images) ? data.images : [];
        let imagecounter = 0;
        let addImage = (parent) => {
            let imghref = images[imagecounter++] ?? "";
            if (imghref == "") {
                return;
            }
            let imgnode = newDoc.dom.createElement("img");
            imgnode.src = WtrlabParser.absoluteUrl(imghref);
            parent.appendChild(imgnode);
        };

        let body = Array.isArray(data.body) ? data.body : String(data.body ?? "").split("\n");
        for (let element of body) {
            if (typeof element !== "string") {
                continue;
            }
            if (/\[\s*image\s*\]/i.test(element)) {
                let pnode = newDoc.dom.createElement("p");
                for (let part of element.split(/(\[\s*image\s*\])/i)) {
                    if (/^\[\s*image\s*\]$/i.test(part)) {
                        addImage(pnode);
                    } else if (part.trim() !== "") {
                        pnode.appendChild(newDoc.dom.createTextNode(this.replaceTextWithCustomTerms(data, part, glossary)));
                    }
                }
                if (pnode.hasChildNodes()) {
                    newDoc.content.appendChild(pnode);
                }
            } else {
                let pnode = newDoc.dom.createElement("p");
                pnode.textContent = this.replaceTextWithCustomTerms(data, element, glossary);
                newDoc.content.appendChild(pnode);
            }
        }
        // images that had no [image] marker
        while (imagecounter < images.length) {
            let pnode = newDoc.dom.createElement("p");
            addImage(pnode);
            if (pnode.hasChildNodes()) {
                newDoc.content.appendChild(pnode);
            }
        }
        return newDoc.dom;
    }

    /**
     * Build the placeholder index -> text table for a chapter.
     * Priority: user terms > story terms > chapter provided terms.
     */
    buildGlossary(data) {
        let glossary = [];
        let terms = data?.glossary_data?.terms ?? [];
        for (let i = 0; i < terms.length; i++) {
            let term = terms[i] ?? [];
            let source = term[1] ?? "";
            let value = Array.isArray(term[0]) ? term[0][0] : term[0];
            for (let story of this.termsstory ?? []) {
                if (source !== "" && source == story?.from) {
                    value = story.to;
                }
            }
            for (let user of this.termsuser ?? []) {
                if (source !== "" && source == user?.from) {
                    value = user.to;
                }
            }
            glossary[i] = value;
        }
        return glossary;
    }

    replaceTextWithCustomTerms(data, element, glossary) {
        // keep backwards compatibility with old call signature (json, element)
        if (data?.data?.data != null) {
            data = data.data.data;
        }
        glossary = glossary ?? this.buildGlossary(data);
        let newtext = WtrlabParser.resolveTokens(element);
        // replace placeholders with provided translation
        newtext = newtext.replace(/(?:wtr-lab\s+)?※(\d+)[⛬〓]/g, (match, index) => glossary[parseInt(index)] ?? match);
        // replace custom terms
        for (let term of this.termsuser ?? []) {
            if (term?.from) {
                newtext = newtext.replaceAll(term.from, term.to ?? "");
            }
        }
        // patch
        // replace with provided chapter patch wtf?!? why are there so many different terms patches etc.?
        for (let patch of data?.patch ?? []) {
            if (patch?.zh) {
                newtext = newtext.replaceAll(patch.zh, " " + (patch.en ?? ""));
            }
        }
        return newtext;
    }

}
