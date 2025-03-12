#!/usr/bin/env python

import argparse, pathlib, sys, glob, os
from termcolor import cprint

default_dir = "content"
debug = False
file_pattern = '*.bib'

def find_files(start, file):
    pattern = f"{start}/**/{file}"
    if debug:
        cprint(f"Looking for {pattern}", "yellow")
    files = glob.glob(pattern, recursive=True)
    return files

def process_file(file):
    from citeproc.source.bibtex import BibTeX
    from citeproc import CitationStylesStyle, CitationStylesBibliography, formatter
    from citeproc_styles import get_style_filepath
    from citeproc import Citation, CitationItem

    bib_src = BibTeX(file, encoding="utf-8")

    # Load CSL file — name can be anything that has a .csl file in the repo
    stylepath = get_style_filepath("chicago-author-date")
    bib_style = CitationStylesStyle(stylepath, validate=False)
    library = CitationStylesBibliography(bib_style, bib_src, formatter.html)
    text = []
    for key in bib_src:
        item = CitationItem(key)
        library.register(Citation([item]))
        text.append(''.join(library.style.render_bibliography([item])[0]))

    return text

def main():
    global debug

    parser = argparse.ArgumentParser(description='Convert BibTex entries')
    parser.add_argument('--dir', type=pathlib.Path, help='directory to process')
    parser.add_argument('--debug', '-d', help='Print information about processing', default=False, action='store_true')
    parser.add_argument('--list', '-l', help='Return unordered list', default=False, action='store_true')

    args = parser.parse_args()

    if args.debug:
        debug = True

    if not args.dir:
        start = default_dir
    else:
        start = args.dir

    files = find_files(start, file_pattern)

    for file in files:
        dir = pathlib.Path(file).parent
        prefix = pathlib.Path(file).stem
        html = process_file(file)
        out = os.path.join(dir, prefix + ".bib.html")
        cprint(f"Processing {str(file)} to {str(out)}", "green")
        content = process_file(file)
        ul = ""
        for c in content:
            if not args.list:
                ul += f'<div class="citation-item">{c}</div>'
            else:
                ul += f'<li class="citation-item">{c}</li>'

        if args.list:
            ul = f'<ul class="citation-list">{ul}</ul>'
        with open(out, "w") as f:
            f.write(f'<div class="citations">{ul}</div>')

if __name__ == "__main__":
    main()
