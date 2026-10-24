"use strict";

module("WtrlabParser");

QUnit.test("extractAuthor - standard two-link author block", function (assert) {
    let html = `
    <div>
        <div class="grid grid-cols-[108px_1fr] items-center gap-x-2.5 px-3.5 py-[9px] border-b border-border last:border-b-0 even:bg-black/[0.016] dark:even:bg-white/[0.022] max-[400px]:grid-cols-1 max-[400px]:gap-0.5 max-[400px]:px-3 max-[400px]:py-2">
            <span class="text-[10.5px] font-bold uppercase tracking-[0.07em] whitespace-nowrap pt-px leading-6 text-muted-foreground">Author</span>
            <div class="text-[13px] leading-relaxed wrap-break-word [&amp;_a]:no-underline [&amp;_a]:font-semibold [&amp;_a:hover]:text-primary flex flex-col gap-px">
                <a href="/en/author/%E9%81%93%E5%B0%8F%E6%98%93">道小易</a>
                <a class="text-xs opacity-65" href="/en/author/%E9%81%93%E5%B0%8F%E6%98%93">Dao Xiao Yi</a>
            </div>
        </div>
    </div>
    `;
    let dom = new DOMParser().parseFromString(html, "text/html");
    let parser = new WtrlabParser();
    let author = parser.extractAuthor(dom);
    assert.equal(author, "道小易 - Dao Xiao Yi");
});

QUnit.test("extractAuthor - single link author block", function (assert) {
    let html = `
    <div>
        <div>
            <span>Author</span>
            <div>
                <a href="/en/author/%E9%81%93%E5%B0%8F%E6%98%93">道小易</a>
            </div>
        </div>
    </div>
    `;
    let dom = new DOMParser().parseFromString(html, "text/html");
    let parser = new WtrlabParser();
    let author = parser.extractAuthor(dom);
    assert.equal(author, "道小易");
});

QUnit.test("extractAuthor - fallback to unknown", function (assert) {
    let html = `
    <div>
        <div>
            <span>Other Field</span>
            <div>
                <a>Someone</a>
            </div>
        </div>
    </div>
    `;
    let dom = new DOMParser().parseFromString(html, "text/html");
    let parser = new WtrlabParser();
    let author = parser.extractAuthor(dom);
    assert.equal(author, "<unknown>");
});

QUnit.test("parseNovelUrl - toc, chapter and serie urls", function(assert) {
    assert.deepEqual(WtrlabParser.parseNovelUrl("https://wtr-lab.com/en/novel/86878/some-slug?tab=toc"),
        {language: "en", id: "86878", slug: "some-slug", chapter: null});
    assert.deepEqual(WtrlabParser.parseNovelUrl("https://wtr-lab.com/en/novel/86878/some-slug/chapter-12"),
        {language: "en", id: "86878", slug: "some-slug", chapter: "12"});
    assert.deepEqual(WtrlabParser.parseNovelUrl("https://wtr-lab.com/es/serie-123/abc/chapter-7"),
        {language: "es", id: "123", slug: "abc", chapter: "7"});
    assert.equal(WtrlabParser.parseNovelUrl("https://wtr-lab.com/en/novel-list"), null);
});

QUnit.test("resolveTokens - debranded text is decoded", function(assert) {
    assert.equal(WtrlabParser.resolveTokens("My %{Novel|Tm92ZWw=} title"), "My Novel title");
    assert.equal(WtrlabParser.resolveTokens("A %{\"safe\":\"U2VjcmV0\"} B"), "A Secret B");
    assert.equal(WtrlabParser.resolveTokens("fallback %{safe|!!!}"), "fallback %{safe|!!!}");
    assert.equal(WtrlabParser.resolveTokens("plain text"), "plain text");
    assert.equal(WtrlabParser.resolveTokens(null), "");
});

QUnit.test("replaceTextWithCustomTerms - glossary placeholders and priorities", function(assert) {
    let parser = new WtrlabParser();
    parser.termsstory = [{from: "林枫", to: "Lin Feng"}];
    parser.termsuser = [];
    let data = {glossary_data: {terms: [["Lyn", "林枫"], [["Sword"], "剑"]]}};
    assert.equal(parser.replaceTextWithCustomTerms(data, "※0⛬ draws the ※1〓."), "Lin Feng draws the Sword.");
    parser.termsuser = [{from: "林枫", to: "Feng"}];
    assert.equal(parser.replaceTextWithCustomTerms(data, "※0⛬ and ※9⛬"), "Feng and ※9⛬");
});

QUnit.test("isCustomError - inline body or content_url are valid", function(assert) {
    let parser = new WtrlabParser();
    assert.notOk(parser.isCustomError({json: {content_url: "/api/x"}}));
    assert.notOk(parser.isCustomError({json: {data: {data: {body: ["a"]}}}}));
    assert.ok(parser.isCustomError({json: {}}));
    assert.ok(parser.isCustomError({json: {code: "CHAPTER_LOCKED"}}));
    assert.ok(parser.isCustomError({json: {requireTurnstile: true, content_url: "/x"}}));
});

QUnit.test("buildChapter - text, inline images and leftover images", function(assert) {
    let parser = new WtrlabParser();
    let json = {data: {data: {
        title: "The Start",
        body: ["Hello %{World|V29ybGQ=}", "[image]", "end"],
        images: ["//img.wtr-lab.com/a.png", "/b.png"]
    }}};
    let dom = parser.buildChapter(json, "https://wtr-lab.com/en/novel/1/slug/chapter-3");
    let content = Parser.findConstructedContent(dom);
    let paragraphs = [...content.querySelectorAll("p")].map(p => p.textContent);
    assert.ok(content.querySelector("h1").textContent.endsWith("The Start"));
    assert.equal(paragraphs[0], "Hello World");
    assert.equal(paragraphs[2], "end");
    let images = [...content.querySelectorAll("img")].map(i => i.getAttribute("src"));
    assert.deepEqual(images, ["https://img.wtr-lab.com/a.png", "https://wtr-lab.com/b.png"]);
});
