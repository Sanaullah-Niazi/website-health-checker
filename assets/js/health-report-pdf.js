// The downloadable PDF of a Website Health & Security Checker report.
// health-checker.js loads this file (with jsPDF and html2canvas-pro from /assets/lib/) only when someone
// clicks "Download PDF". It lays the report out as a real document: a cover page, an executive summary,
// findings by severity, detailed results, screenshots and a page about the method. Each A4 page is built
// with DOM nodes (never innerHTML), drawn with html2canvas-pro and saved as one PDF file.
// Drawing the pages in the browser keeps Urdu, Chinese and German text exactly as the site shows it.
(function () {
  var PAGE_W = 794, PAGE_H = 1123; // A4 at 96 dpi
  var SEVS = ["critical", "high", "medium", "low"];

  window.webReportPdf = function (d, k) {
    var tr = k.tr, h = k.h, num = k.num, ltr = k.ltr, r = d.report;
    var holder = h("div", { class: "wpdf", dir: k.rtl ? "rtl" : "ltr", lang: k.lang, "aria-hidden": "true" });
    document.body.appendChild(holder);

    // ---------- Pages ----------
    var pages = [];
    function newPage(cover) {
      var body = h("div", { class: "wpdf-body" });
      var page = h("section", { class: "wpdf-page" + (cover ? " wpdf-cover" : "") },
        cover ? null : h("header", { class: "wpdf-head" },
          h("span", null, tr("w_pdf_title"), " · ", ltr(d.host)),
          h("span", null, k.fmtDate(d.created))),
        body,
        cover ? null : h("footer", { class: "wpdf-foot" },
          h("span", { class: "wpdf-link", "data-url": "https://" + location.host + "/" }, ltr(location.host)),
          h("span", { class: "wpdf-num" })));
      holder.appendChild(page);
      pages.push(page);
      return body;
    }
    // Adds blocks to pages, starting a new page whenever the next block doesn't fit.
    var body = null;
    function overflows(b) { return b.scrollHeight > b.clientHeight + 1; }
    // newPage: true always starts a page; "soft" starts one only when less than about a third of the page is left.
    function spaceLeft(b) {
      var last = b.lastElementChild;
      return last ? b.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom : b.clientHeight;
    }
    function add(block, opts) {
      if (!block) return;
      var np = opts && opts.newPage;
      if (!body || np === true || (np === "soft" && spaceLeft(body) < 340)) body = newPage();
      body.appendChild(block);
      if (overflows(body) && body.childNodes.length > 1) {
        body.removeChild(block);
        body = newPage();
        body.appendChild(block);
      }
    }

    // ---------- Cover ----------
    var cover = newPage(true);
    var counts = {};
    SEVS.forEach(function (s) { counts[s] = r.issues.filter(function (i) { return i.sev === s; }).length; });
    var tiles = h("ul", { class: "wpdf-tiles" });
    k.CATS.forEach(function (c) {
      var s = r.scores[c];
      tiles.appendChild(h("li", null,
        h("span", null, tr("cat_" + c)),
        h("b", { class: "g-" + k.scoreClass(s) }, s == null ? tr("w_na") : num(s))));
    });
    cover.appendChild(h("div", { class: "wpdf-cover-band" },
      h("p", { class: "wpdf-brand" }, k.brand, " · ", ltr(location.host)),
      h("h1", null, tr("w_pdf_title")),
      h("p", { class: "wpdf-host" }, ltr(d.host)),
      h("p", { class: "wpdf-url" }, ltr(d.url)),
      h("p", { class: "wpdf-date" }, tr("w_scanned", { t: k.fmtDate(d.created, true) }))));
    cover.appendChild(h("div", { class: "wpdf-cover-score" },
      k.ring(r.overall, r.grade),
      h("div", null,
        h("p", { class: "wpdf-label" }, tr("w_overall")),
        h("p", { class: "wpdf-big" }, r.overall == null ? tr("w_na") : num(r.overall) + " / 100"),
        h("p", { class: "wpdf-gradeline" }, tr("w_grade") + " " + (r.grade || "–")))));
    cover.appendChild(tiles);
    cover.appendChild(sevCounts(counts));
    cover.appendChild(h("p", { class: "wpdf-cover-note" }, k.passive));

    // ---------- Executive summary ----------
    add(h("h2", null, tr("w_pdf_summary")), { newPage: true });
    add(h("p", { class: "wpdf-lead" }, tr("w_pdf_sum_" + (r.grade || "na"), { host: d.host, n: num(r.issues.length) })));
    if (CATS_missing()) add(h("p", { class: "wpdf-note" }, tr("w_partial")));
    var table = h("table", { class: "wpdf-scores" });
    k.CATS.forEach(function (c) {
      var s = r.scores[c];
      var fill = h("i", { class: "g-" + k.scoreClass(s) });
      fill.style.width = (s == null ? 0 : s) + "%";
      table.appendChild(h("tr", null,
        h("th", { scope: "row" }, tr("cat_" + c)),
        h("td", { class: "wpdf-bar" }, h("span", null, fill)),
        h("td", { class: "wpdf-score g-" + k.scoreClass(s) }, s == null ? tr("w_na") : num(s))));
    });
    add(h("div", null, h("h3", null, tr("w_pdf_scores")), table));
    if (r.top.length) {
      var top = r.top.map(function (i) { return r.issues[i]; });
      top.forEach(function (issue, n) {
        var t = k.issueText(issue);
        var row = h("div", { class: "wpdf-top" },
          h("span", { class: "wpdf-top-n" }, num(n + 1)),
          h("div", null,
            h("p", { class: "wpdf-top-title" }, sevPill(issue.sev), " ", t.title),
            h("p", null, h("strong", null, tr("w_fix") + ": "), t.fix)));
        add(n === 0 ? h("div", null, h("h3", null, tr("w_top5")), row) : row);
      });
    } else add(h("div", null, h("h3", null, tr("w_top5")), h("p", { class: "wpdf-good" }, tr("w_top5_none"))));

    // ---------- Findings by severity ----------
    add(h("h2", { class: "wpdf-h-gap" }, tr("w_pdf_findings")), { newPage: "soft" });
    if (!r.issues.length) add(h("p", { class: "wpdf-good" }, tr("w_top5_none")));
    SEVS.forEach(function (sev) {
      var list = r.issues.filter(function (i) { return i.sev === sev; });
      list.forEach(function (issue, n) {
        var card = finding(issue);
        add(n === 0 ? h("div", null, h("h3", { class: "wpdf-sev-h sev-" + sev }, tr("sev_" + sev) + " (" + num(list.length) + ")"), card) : card);
      });
    });

    // ---------- Detailed results ----------
    add(h("h2", { class: "wpdf-h-gap" }, tr("w_pdf_details")), { newPage: "soft" });
    k.CATS.forEach(function (cat) {
      var f = k.FACTS[cat](d);
      var s = r.scores[cat];
      var head = h("div", { class: "wpdf-cat-h" },
        h("h3", null, tr("cat_" + cat)),
        h("b", { class: "g-" + k.scoreClass(s) }, s == null ? tr("w_na") : num(s) + "/100"));
      // One block per row, so a long section can continue on the next page.
      var rows = f ? [].slice.call(f.querySelectorAll(".web-facts > div")) : [];
      if (!rows.length) { add(h("div", { class: "wpdf-cat" }, head, h("p", { class: "wpdf-note" }, tr("w_na")))); return; }
      rows.forEach(function (row, n) {
        var dl = h("dl", { class: "web-facts" }, row);
        add(n === 0 ? h("div", { class: "wpdf-cat" }, head, dl) : h("div", { class: "wpdf-cat-more" }, dl));
      });
    });

    // ---------- Screenshots ----------
    if (d.shots && (d.shots.desktop || d.shots.mobile)) {
      add(h("h2", null, tr("w_screens")), { newPage: true });
      add(h("div", { class: "wpdf-shots" },
        d.shots.desktop ? h("figure", { class: "wpdf-shot-d" }, h("img", { src: d.shots.desktop, alt: "" }), h("figcaption", null, tr("w_desktop"))) : null,
        d.shots.mobile ? h("figure", { class: "wpdf-shot-m" }, h("img", { src: d.shots.mobile, alt: "" }), h("figcaption", null, tr("w_mobile"))) : null));
    }

    // ---------- About this report ----------
    add(h("div", { class: "wpdf-about" },
      h("h2", null, tr("w_pdf_about")),
      h("p", null, k.passive),
      h("p", null, tr("w_pdf_method")),
      h("p", null, tr("w_expires", { d: k.fmtDate(d.expires) })),
      h("p", null, tr("w_pdf_online"), " ", h("span", { class: "wpdf-link", "data-url": k.shareUrl }, ltr(k.shareUrl)))));

    pages.forEach(function (p, i) {
      var n = p.querySelector(".wpdf-num");
      if (n) n.textContent = tr("w_pdf_page", { n: num(i + 1), t: num(pages.length) });
    });

    // ---------- Draw ----------
    var pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4", compress: true });
    var scale = 210 / PAGE_W; // mm per CSS pixel
    var chain = Promise.resolve();
    pages.forEach(function (page, i) {
      chain = chain.then(function () {
        return window.html2canvas(page, { scale: 1.75, backgroundColor: "#ffffff", logging: false, width: PAGE_W, height: PAGE_H, windowWidth: PAGE_W, onclone: stylesReady });
      }).then(function (canvas) {
        if (i) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.85), "JPEG", 0, 0, 210, 297, undefined, "FAST");
        // Keep the links clickable.
        var base = page.getBoundingClientRect();
        [].forEach.call(page.querySelectorAll(".wpdf-link"), function (a) {
          var b = a.getBoundingClientRect();
          pdf.link((b.left - base.left) * scale, (b.top - base.top) * scale, b.width * scale, b.height * scale, { url: a.getAttribute("data-url") });
        });
      });
    });
    return chain.then(function () {
      pdf.setProperties({ title: tr("w_pdf_title") + " · " + d.host, subject: d.url, creator: k.brand + " · " + location.host });
      pdf.save("website-report-" + d.host.replace(/[^a-z0-9.-]/gi, "") + "-" + new Date(d.created).toISOString().slice(0, 10) + ".pdf");
    }).then(function () { holder.remove(); }, function (e) { holder.remove(); throw e; });

    // ---------- Helpers ----------
    // html2canvas draws a copy of the page in a hidden frame, and that copy fetches the stylesheet again. When the
    // server says not to cache it, the copy can be drawn before the styles arrive, giving a plain, unstyled page.
    // So wait until every stylesheet and font in the copy has loaded (at most 8 seconds).
    function stylesReady(doc) {
      var links = [].slice.call(doc.querySelectorAll('link[rel="stylesheet"]'));
      var waits = links.map(function (l) {
        if (l.sheet) return Promise.resolve();
        return new Promise(function (ok) { l.addEventListener("load", ok); l.addEventListener("error", ok); });
      });
      if (doc.fonts && doc.fonts.ready) waits.push(doc.fonts.ready);
      return Promise.race([Promise.all(waits), new Promise(function (ok) { setTimeout(ok, 8000); })]);
    }
    function CATS_missing() { return k.CATS.some(function (c) { return r.scores[c] == null; }); }
    function sevPill(sev) { return h("span", { class: "web-sev sev-" + sev }, tr("sev_" + sev)); }
    function sevCounts(c) {
      var ul = h("ul", { class: "wpdf-counts" });
      SEVS.forEach(function (s) { ul.appendChild(h("li", { class: "sev-" + s }, h("b", null, num(c[s])), h("span", null, tr("sev_" + s)))); });
      return h("div", null, h("p", { class: "wpdf-label" }, tr("w_pdf_counts")), ul);
    }
    function finding(issue) {
      var t = k.issueText(issue);
      return h("div", { class: "wpdf-issue sev-" + issue.sev },
        h("p", { class: "wpdf-issue-meta" }, sevPill(issue.sev), " ", h("span", null, tr("cat_" + issue.cat))),
        h("p", { class: "wpdf-issue-title" }, t.title),
        t.what ? h("p", null, h("strong", null, tr("w_what") + ": "), t.what) : null,
        h("p", null, h("strong", null, tr("w_fix") + ": "), t.fix),
        t.link ? h("p", { class: "wpdf-more" }, tr("w_learn") + ": ", h("span", { class: "wpdf-link", "data-url": t.link }, ltr(t.link))) : null);
    }
  };
})();
