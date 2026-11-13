/**
 * Autocompletion for C++ in the code editor. `@codemirror/lang-cpp` only
 * highlights, so this supplies what `@codemirror/lang-python` ships built in:
 * keywords, common standard library names, snippets and the names already
 * used in the file. It is a word list, not a compiler: nothing is type-aware.
 *
 *   extensions={[cpp(), cppCompletion]}
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  ifNotIn,
  insertCompletionText,
  snippetCompletion,
} from "@codemirror/autocomplete";
import { cppLanguage } from "@codemirror/lang-cpp";
import type { EditorView } from "@uiw/react-codemirror";

function completions(type: string, names: string): Completion[] {
  return names.split(/\s+/).map((label) => ({ label, type }));
}

const KEYWORDS = completions(
  "keyword",
  `auto bool break case catch char class const const_cast constexpr continue decltype default delete do double
   dynamic_cast else enum explicit extern false final float for friend goto if inline int long mutable namespace new
   noexcept nullptr operator override private protected public reinterpret_cast return short signed sizeof static
   static_cast struct switch template this throw true try typedef typename union unsigned using virtual void volatile
   while`,
);

const STD_TYPES = completions(
  "class",
  `array bitset deque function greater ifstream int16_t int32_t int64_t int8_t istringstream less list map multimap
   multiset numeric_limits ofstream optional ostringstream pair priority_queue queue set shared_ptr size_t stack string
   string_view stringstream tuple uint16_t uint32_t uint64_t uint8_t unique_ptr unordered_map unordered_set variant
   vector`,
);

const STD_FUNCTIONS = completions(
  "function",
  `abs accumulate advance all_of any_of binary_search ceil clamp copy count count_if distance fill find find_if fixed
   floor for_each gcd get getline iota isalnum isalpha isdigit islower isspace isupper lcm lower_bound make_pair
   make_tuple max max_element min min_element move next next_permutation none_of nth_element partial_sum pow prev
   prev_permutation printf puts reverse rotate round scanf setfill setprecision setw sort sqrt stable_sort stod stoi
   stoll swap tie to_string tolower toupper transform unique upper_bound`,
);

const STD_OBJECTS = completions("variable", "cerr cin cout endl");

/** Names valid after `std::`. */
const STD = [...STD_TYPES, ...STD_FUNCTIONS, ...STD_OBJECTS];

const MACROS = completions(
  "constant",
  "EOF INT_MAX INT_MIN LLONG_MAX LLONG_MIN NULL assert",
);

const SNIPPETS = [
  snippetCompletion("int main() {\n\t${}\n\treturn 0;\n}", {
    label: "main",
    detail: "function",
    type: "keyword",
  }),
  snippetCompletion("for (int ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}", {
    label: "for",
    detail: "loop",
    type: "keyword",
  }),
  snippetCompletion("for (${auto}& ${item} : ${items}) {\n\t${}\n}", {
    label: "for",
    detail: "range loop",
    type: "keyword",
  }),
  snippetCompletion("while (${condition}) {\n\t${}\n}", {
    label: "while",
    detail: "loop",
    type: "keyword",
  }),
  snippetCompletion("do {\n\t${}\n} while (${condition});", {
    label: "do",
    detail: "loop",
    type: "keyword",
  }),
  snippetCompletion("if (${condition}) {\n\t${}\n}", {
    label: "if",
    detail: "block",
    type: "keyword",
  }),
  snippetCompletion("if (${condition}) {\n\t${}\n} else {\n\t${}\n}", {
    label: "if",
    detail: "/ else block",
    type: "keyword",
  }),
  snippetCompletion("switch (${value}) {\n\tcase ${constant}:\n\t\t${}\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}", {
    label: "switch",
    detail: "block",
    type: "keyword",
  }),
  snippetCompletion("struct ${Name} {\n\t${}\n};", {
    label: "struct",
    detail: "definition",
    type: "keyword",
  }),
  snippetCompletion("class ${Name} {\npublic:\n\t${}\n};", {
    label: "class",
    detail: "definition",
    type: "keyword",
  }),
];

/** Offered anywhere a name can start. */
const GLOBAL = [
  ...KEYWORDS,
  ...SNIPPETS,
  ...STD,
  ...MACROS,
  { label: "std", type: "namespace" },
];

/** Offered after `.` and `->`: members of the common containers, strings and streams. */
const MEMBERS = [
  ...completions(
    "method",
    `append assign at back begin c_str clear compare contains count data emplace emplace_back empty end ends_with erase
     find find_first_of front ignore insert length lower_bound pop pop_back pop_front precision push push_back
     push_front rbegin rend replace reserve resize rfind size starts_with substr swap sync_with_stdio tie top
     upper_bound`,
  ),
  ...completions("property", "first second"),
];

/** Inserts the header name and closes the bracket unless a `>` is already there. */
function applyHeader(view: EditorView, completion: Completion, from: number, to: number) {
  const closed = view.state.sliceDoc(to, to + 1) === ">";
  view.dispatch(insertCompletionText(view.state, completion.label + (closed ? "" : ">"), from, to));
}

const HEADERS: Completion[] = `algorithm array bit bits/stdc++.h bitset cassert cctype chrono climits cmath complex
  cstdint cstdio cstdlib cstring deque format fstream functional iomanip iostream iterator limits list map memory
  numbers numeric optional queue random ranges set span sstream stack string string_view tuple unordered_map
  unordered_set utility variant vector`
  .split(/\s+/)
  .map((label) => ({ label, type: "text", apply: applyHeader }));

const DIRECTIVES: Completion[] = [
  { label: "include", type: "keyword", apply: "include " },
  ...completions("keyword", "define undef ifdef ifndef if elif else endif pragma"),
];

function labels(options: readonly Completion[]) {
  return new Set(options.map((option) => option.label));
}

// A name in a fixed list is not repeated as a name from the file: the popup
// would show it twice, since the two entries differ in type.
const GLOBAL_LABELS = labels(GLOBAL);
const STD_LABELS = labels(STD);
const MEMBER_LABELS = labels(MEMBERS);
const NO_LABELS = new Set<string>();

/**
 * Names used in the file, except the one being typed at `from` and those in
 * `known`. Scanning the whole text is cheap at the 64 KB source limit, and
 * CodeMirror only asks again when the typed word stops matching `validFor`.
 */
function namesInFile(context: CompletionContext, from: number, known: Set<string>): Completion[] {
  const seen = new Set<string>();
  for (const match of context.state.doc.toString().matchAll(/[A-Za-z_]\w+/g)) {
    if (match.index !== from && !known.has(match[0])) seen.add(match[0]);
  }
  return Array.from(seen, (label) => ({ label, type: "variable" }));
}

/** `#include <…` and `#directive`, which the code source below would not understand. */
function preprocessorSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);

  const header = /^\s*#\s*include\s*<([\w./+]*)$/.exec(before);
  if (header) {
    return { from: context.pos - header[1].length, options: HEADERS, validFor: /^[\w./+]*$/ };
  }
  const directive = /^\s*#\s*(\w*)$/.exec(before);
  if (directive) {
    return { from: context.pos - directive[1].length, options: DIRECTIVES, validFor: /^\w*$/ };
  }
  return null;
}

function codeSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\w+/);
  // Without a typed letter the popup only opens on request (Ctrl+Space).
  if (!word && !context.explicit) return null;
  if (word && /^\d/.test(word.text)) return null;
  const from = word ? word.from : context.pos;

  const before = context.state.sliceDoc(Math.max(0, from - 5), from);
  let fixed = GLOBAL;
  let known = GLOBAL_LABELS;
  if (before.endsWith(".") || before.endsWith("->")) {
    fixed = MEMBERS;
    known = MEMBER_LABELS;
  } else if (before.endsWith("::")) {
    // Only std's contents are known; another scope gets the file's names.
    const std = /(^|\W)std::$/.test(before);
    fixed = std ? STD : [];
    known = std ? STD_LABELS : NO_LABELS;
  }

  return {
    from,
    options: [...fixed, ...namesInFile(context, from, known)],
    validFor: /^\w*$/,
  };
}

const outsideTextSource = ifNotIn(
  ["LineComment", "BlockComment", "String", "RawString", "CharLiteral", "Number"],
  codeSource,
);

/** Add next to `cpp()`; the editor's autocompletion picks it up as language data. */
export const cppCompletion = cppLanguage.data.of({
  autocomplete: (context: CompletionContext) =>
    preprocessorSource(context) ?? outsideTextSource(context),
});
