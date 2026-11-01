"use strict";

parserFactory.register("wtr-lab.com", () => new WtrlabParser());

class WtrlabParser extends Parser {
    constructor() {
        super();
        this.minimumThrottle = 12000;
    }

    populateUIImpl() {
        document.getElementById("removeChapterNumberRow").hidden = false; 
        // raw download no longer supported as the raw text is encoded and i don't know how.
        // leaving old code in case it gets solved.
        // document.getElementById("selectTranslationAiRow").hidden = false;
        document.getElementById("selectRetryLongerRow").hidden = false;  
    }

    async getChapterUrls(dom) {
        let tocHtml = (await HttpClient.wrapFetch(dom.baseURI)).responseXML;
        let json = tocHtml.querySelector("script#__NEXT_DATA__")?.textContent;
        json = JSON.parse(json);
        this.magickey = json?.buildId;
        let leaves = tocHtml.baseURI.split("/");
        let novelIndex = leaves.indexOf("novel");
        let language = leaves[novelIndex - 1];
        let id = leaves[novelIndex + 1];
        let slug = leaves[leaves.length - 1].split("?")[0];
        this.slug = slug;
        let chapters = (await HttpClient.fetchJson("https://wtr-lab.com/api/chapters/" + id)).json;
        let serie_id = chapters.chapters[0].serie_id;
        this.chapterIds = {};
        for (let c of chapters.chapters) {
            if (c?.id != null) {
                this.chapterIds[String(c.order)] = c.id;
            }
        }
        try {
            let terms = (await HttpClient.fetchJson("https://wtr-lab.com/api/v2/user/config")).json;
            terms = terms?.config?.terms.filter(a => (a[4] == null) || (a[4].includes(serie_id)));
            terms = terms.map(a => ({from:a[2].split("|").filter(a => a != ""), to:a[1]}));
            let index = 0;
            this.termsuser = [];
            for (let i = 0; i < terms.length; i++) {
                for (let j = 0; j < terms[i].from.length; j++) {
                    this.termsuser[index] = ({from: terms[i].from[j], to: terms[i].to});
                    index++;
                }
            }

        } catch (error) {
            this.termsuser = [];
        }
        //entire stories have their own terms that superseed the chapter ones
        try {
            let terms = (await HttpClient.fetchJson("https://wtr-lab.com/api/v2/reader/terms/"+id+".json")).json;
            let termstmp = {};
            for (let i = 0; i < terms?.glossaries?.length; i++) {
                for (let j = 0; j < terms.glossaries[i]?.data?.terms?.length; j++) {
                    if (terms.glossaries[i]?.data.terms[j]?.length>1 && terms.glossaries[i]?.data.terms[j][0].length>0) {
                        termstmp[terms.glossaries[i].data.terms[j][1]] = terms.glossaries[i].data.terms[j][0][0];
                    }
                }
            }
            this.termsstory = [];
            let index = 0;
            for (let key in termstmp) {
                this.termsstory[index++] = ({from: key, to: termstmp[key]});
            }
        } catch (error) {
            this.termsstory = [];
        }
        return chapters.chapters.map(a => ({
            sourceUrl: "https://wtr-lab.com/"+language+"/novel/"+id+"/"+slug+"/chapter-"+a.order, 
            title: (document.getElementById("removeChapterNumberCheckbox").checked)?a.title:a.order+": "+a.title
        }));
    }


    async loadEpubMetaInfo(dom) {
        let tocHtml = (await HttpClient.wrapFetch(dom.baseURI)).responseXML;
        let json = tocHtml.querySelector("script#__NEXT_DATA__")?.textContent;
        json = JSON.parse(json);
        this.img = json?.props.pageProps.serie.serie_data.data.image;
        return;
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
        return dom.querySelector("h1");
    }

    findCoverImageUrl() {
        return this.img;
    }

    extractSubject(dom) {
        let tagsgenre = [...dom.querySelectorAll("span.genre")].map(a => a.textContent);
        let tagstags = [...dom.querySelectorAll(".tags a.tag")].map(a => a.textContent.replace(",", ""));
        let tags = tagsgenre;
        tags = tags.concat(tagstags);
        return tags.map(e => e.trim()).join(", ");
    }

    extractDescription(dom) {
        let desc = dom.querySelector("span.description");
        return desc.textContent.trim();
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
                return links.map(link => link.textContent.trim()).join(" - ");
            }
        }
        return super.extractAuthor(dom);
    }

    async fetchChapter(url) {
        let leaves = url.split("/");
        let novelIndex = leaves.indexOf("novel");
        let language = leaves[novelIndex - 1];
        let id = leaves[novelIndex + 1];
        let chapterPart = leaves[leaves.length - 1];
        let chapter = chapterPart.startsWith("chapter-")
            ? chapterPart.slice(8)
            : chapterPart;
        let fetchUrl = "https://wtr-lab.com/api/reader/get";
        let formData = 
            {
                "translate":"ai",
                "language":language,
                "raw_id":id,
                "chapter_no":chapter,
                "retry":false,
                "force_retry":false
            };
        let chapterId = this.chapterIds?.[String(chapter)];
        if (chapterId != null) {
            formData.chapter_id = chapterId;
        }
        let header = {"Content-Type": "application/json;charset=UTF-8"};
        let options = {
            method: "POST",
            body: JSON.stringify(formData),
            headers: header,
            parser: this
        };
        let json = (await HttpClient.fetchJson(fetchUrl, options)).json;
        let contentjson = json;
        if (!WtrlabParser.findBodyContainer(json) && json?.content_url) {
            let contentUrl = json.content_url;
            if (contentUrl.startsWith("//")) {
                contentUrl = "https:" + contentUrl;
            } else if (contentUrl.startsWith("/")) {
                contentUrl = "https://wtr-lab.com" + contentUrl;
            }
            let text = (await HttpClient.fetchText(contentUrl));
            contentjson = WtrlabParser.parseContentResponse(text, json);
        }
        await this.decryptBody(contentjson);
        return this.buildChapter(contentjson, url);
    }

    // Content endpoint may return JSON (in several layouts), or the raw
    // encrypted body string ("arr:..." / "str:...") on its own.
    static parseContentResponse(text, readerJson) {
        text = (text ?? "").trim();
        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            parsed = text;
        }
        if (typeof parsed === "string" || Array.isArray(parsed)) {
            let data = readerJson?.data?.data ?? {};
            return { data: { data: { ...data, body: parsed } } };
        }
        let container = WtrlabParser.findBodyContainer(parsed);
        if (container && container !== parsed?.data?.data) {
            return { data: { data: container } };
        }
        return parsed;
    }

    static findBodyContainer(json) {
        let usable = (v) => (Array.isArray(v) || typeof v === "string") && v.length > 0;
        let walk = (obj, depth) => {
            if (obj == null || typeof obj !== "object" || depth > 6) {
                return null;
            }
            if (!Array.isArray(obj) && usable(obj.body)) {
                return obj;
            }
            let values = Array.isArray(obj) ? obj.slice(0, 10) : Object.values(obj);
            for (let v of values) {
                let found = walk(v, depth + 1);
                if (found) {
                    return found;
                }
            }
            return null;
        };
        if (usable(json?.data?.data?.body)) {
            return json.data.data;
        }
        return walk(json, 0);
    }

    async decryptBody(json) {
        let data = json?.data?.data;
        if (data == null || typeof data.body !== "string") {
            return;
        }
        data.body = await WtrlabParser.decryptText(data.body);
    }

    // Body format: "arr:<iv b64>:<tag b64>:<ciphertext b64>" (AES-GCM, JSON array)
    // or "str:..." (plain string)
    static async decryptText(encrypted) {
        let isArray = encrypted.startsWith("arr:");
        if (!isArray && !encrypted.startsWith("str:")) {
            return [encrypted];
        }
        let parts = encrypted.substring(4).split(":");
        if (parts.length != 3) {
            throw new Error("WTR-LAB: invalid encrypted chapter body format");
        }
        let b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        let iv = b64ToBytes(parts[0]);
        let tag = b64ToBytes(parts[1]);
        let cipher = b64ToBytes(parts[2]);
        let combined = new Uint8Array(cipher.length + tag.length);
        combined.set(cipher, 0);
        combined.set(tag, cipher.length);
        let key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(WtrlabParser.AES_KEY),
            { name: "AES-GCM" },
            false,
            ["decrypt"]
        );
        let plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, combined);
        let text = new TextDecoder("utf-8").decode(plain);
        let decoded = isArray ? JSON.parse(text) : text;
        return Array.isArray(decoded) ? decoded.map(a => String(a)) : [String(decoded)];
    }
    
    isCustomError(response) {
        if (response.json?.code == "CHAPTER_LOCKED") {
            return true;
        }
        if (!response.json?.content_url && !WtrlabParser.findBodyContainer(response.json)) {
            return true;
        }
        if (response.json.requireTurnstile) {
            return true;
        }
        return false;
    }

    setCustomErrorResponse(url, wrapOptions, checkedresponse) {
        if (checkedresponse.json?.code == "CHAPTER_LOCKED") {
            let newresp = {};
            newresp.wrapOptions = wrapOptions;
            newresp.response = {};
            newresp.response.url = this.PostToUrl(checkedresponse.response.url, JSON.parse(wrapOptions.fetchOptions.body));
            newresp.response.status = 999;
            newresp.response.retryDelay = [];
            newresp.errorMessage = "Fetch of URL '"+newresp.response.url+"' failed.\nThe Chapter isn't Ai translated.";
            return newresp;
        }
        if (checkedresponse.json?.requireTurnstile || checkedresponse.json?.code == 1401) {
            let newresp = {};
            newresp.url = url;
            newresp.wrapOptions = wrapOptions;
            newresp.response = {};
            newresp.response.url = this.PostToUrl(checkedresponse.response.url, JSON.parse(wrapOptions.fetchOptions.body));
            newresp.response.status = 403;
            return newresp;
        } else {
            let newresp = {};
            newresp.url = url;
            newresp.wrapOptions = wrapOptions;
            newresp.response = {};
            newresp.response.url = this.PostToUrl(checkedresponse.response.url, JSON.parse(wrapOptions.fetchOptions.body));
            newresp.response.status = 999;
            if (document.getElementById("selectRetryLongerCheckbox").checked) {
                newresp.response.retryDelay = [80,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120,120];
            } else {
                newresp.response.retryDelay = [80,40,25,25,25];
            }
            newresp.errorMessage = "Fetch of URL '"+newresp.response.url+"' failed.\nThe server sends an empty Chapter try to open the URL and try again if you can see the Chapter on the normal website.\nIt could also be that you try to get an Ai translated novel that isn't Ai tranlated.";
            return newresp;
        }
    }

    PostToUrl(url, body) {
        let hostname = new URL(url).hostname;
        let translate = body.translate;
        let language = body.language;
        let raw_id = body.raw_id;
        let chapter_no = body.chapter_no;
        return "https://"+hostname+"/"+language+"/novel/"+raw_id+"/"+this.slug+"/chapter-"+chapter_no+"?service="+translate;
    }

    buildChapter(json, url) {
        let leaves = url.split("/");
        let chapter = leaves[leaves.length - 1].replace("chapter-","");
        let newDoc = Parser.makeEmptyDocForContent(url);
        let title = newDoc.dom.createElement("h1");
        title.textContent = this.replaceTextWithCustomTerms(json, ((document.getElementById("removeChapterNumberCheckbox").checked)?"":chapter+": ")+json.data.data.title);
        newDoc.content.appendChild(title);
        let br = newDoc.dom.createElement("br");
        let imagecounter = 0;
        let body = json.data.data.body;
        if (typeof body === "string") {
            body = [body];
        }
        for (let element of body) {
            if (element == "[image]") {
                let imgnode = newDoc.dom.createElement("img");
                let imghref = json.data.data?.images?.[imagecounter++]??"";
                if (imghref == "") {
                    continue;
                }
                imgnode.src = imghref;
                newDoc.content.appendChild(imgnode);
            } else {
                let pnode = newDoc.dom.createElement("p");
                let newtext = this.replaceTextWithCustomTerms(json, element);
                pnode.textContent = newtext;
                newDoc.content.appendChild(pnode);
            }
            newDoc.content.appendChild(br);
        }
        return newDoc.dom;
    }

    replaceTextWithCustomTerms(json, element) {
        let newtext = element;
        // replace chapter provided translation with story one
        for (let i = 0; i < json?.data?.data?.glossary_data?.terms?.length??0; i++) {
            for (let term of this.termsstory) {
                if ((json.data.data.glossary_data.terms[i][1]??"") == term?.from) {
                    json.data.data.glossary_data.terms[i][0] = term?.to;
                }
            }
        }
        // replace chapter provided translation with user one
        for (let i = 0; i < json?.data?.data?.glossary_data?.terms?.length??0; i++) {
            for (let term of this.termsuser) {
                if ((json.data.data.glossary_data.terms[i][1]??"") == term?.from) {
                    json.data.data.glossary_data.terms[i][0] = term?.to;
                }
            }
        }
        // replace with provided translation
        for (let i = 0; i < json?.data?.data?.glossary_data?.terms?.length??0; i++) {
            let term = json.data.data.glossary_data.terms[i][0]??"※"+i+"⛬";
            newtext = newtext.replaceAll("※"+i+"⛬", term);
            newtext = newtext.replaceAll("※" + i + "〓", term);
        }
        // replace custom terms
        for (let term of this.termsuser) {
            newtext = newtext.replaceAll(term?.from, term?.to);
        }
        // patch
        // replace with provided chapter patch wtf?!? why are there so many different terms patches etc.?
        for (let i = 0; i < json?.data?.data?.patch?.length??0; i++) {
            newtext = newtext.replaceAll(json?.data?.data?.patch[i].zh, " "+json?.data?.data?.patch[i].en);
        }
        return newtext;
    }

}

WtrlabParser.AES_KEY = "IJAFUUxjM25hyzL2AZrn0wl7cESED6Ru";
