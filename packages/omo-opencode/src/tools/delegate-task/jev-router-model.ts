export const MODEL = "jev-1.14.0"
export const OPTIONS = ["code_change", "investigation_only", "verification_run", "documentation_prose", "visual_ui", "review_judgment", "other"] as const
export type Order = "listed" | "reversed"

const work = {
  code_change: {
    what: "Produce or repair executable code, tests, configuration, or build wiring. Checks support the requested change.",
    not_for: "Diagnosis without a repair; supplied checks only; composing prose; frontend/UI work; candidate review without edits.",
    examples: ["Add a backend parser case", "Apply an established authorization repair"],
  },
  investigation_only: {
    what: "Read evidence, trace behavior, extract existing facts, find a cause, or resolve design alternatives, then report without implementation.",
    not_for: "Implementing a repair; composing documentation from settled facts; judging an existing candidate; supplied checks only.",
    examples: ["Trace a stalled request", "Extract an existing procedure", "Research competing architecture guarantees and recommend a design"],
  },
  verification_run: {
    what: "Execute supplied checks or commands against existing work and report observed results.",
    not_for: "Designing a repair; diagnosing an unexplained cause; independently judging candidate correctness.",
    examples: ["Run the listed compile commands", "Replay a supplied reproduction and report output"],
  },
  documentation_prose: {
    what: "Compose or revise documentation, a report, or other prose from settled technical facts; the main work is producing wording.",
    not_for: "Exact supplied text substitutions; copying status values; extracting existing text; deciding an architecture; reporting diagnosis or a review verdict.",
    examples: ["Explain an installation procedure for users", "Draft a release description from supplied facts"],
  },
  visual_ui: {
    what: "Create or change frontend/UI behavior, components, formatters, layout, styling, animation, UX, or a design system.",
    not_for: "Backend behavior; documentation about an interface; read-only review of UI code or rendered UI evidence.",
    examples: ["Repair a table's value formatter", "Change a component event handler", "Adjust responsive spacing"],
  },
  review_judgment: {
    what: "Inspect existing code, a design, or evidence against requirements and return an independent correctness or security verdict.",
    not_for: "Executing supplied checks only; investigating an unexplained symptom without a candidate; applying a known repair.",
    examples: ["Review a patch for regressions", "Judge UI behavior from screenshots and code"],
  },
  other: {
    what: "Perform an administrative action, a supplied literal text substitution, or a structured record update.",
    not_for: "Code or UI changes; diagnosis or evidence extraction; check execution; prose composition; candidate review.",
    examples: ["Change an issue's workflow state", "Copy verified statuses into a table", "Replace supplied text verbatim"],
  },
} as const

export function questions(order: Order = "listed") {
  return {
    kind_of_work: {
      type: "choice",
      instructions: "What is the main work requested in `task`?",
      criteria: Object.fromEntries((order === "listed" ? OPTIONS : [...OPTIONS].reverse()).map(key => [key, work[key]])),
    },
    approach_is_known: {
      type: "noul",
      instructions: "Does `task` already identify the approach the worker should use?",
      criteria: {
        true: "A repair method, implementation pattern, investigation procedure, or review method is supplied. Local choices may remain.",
        false: "The worker must choose the method from competing approaches; only the goal, symptom, or desired guarantee is supplied.",
      },
    },
    owner_is_known: {
      type: "noul",
      instructions: "Does `task` identify the area responsible for the requested behavior or artifact?",
      criteria: {
        true: "A responsible component, module, document, or operational target is identified, even when several files belong to it.",
        false: "The worker must locate the responsible area or decide which of several owners should hold the behavior.",
      },
    },
    how_settled: {
      type: "score",
      instructions: "What decisions remain open in `task`?",
      criteria: [
        "Exact substitutions or commands are supplied. Edits and result handling are fixed. The worker executes them without selecting evidence, interpreting correctness, or composing wording.",
        "An established pattern settles the behavior. Routine coding, evidence extraction, record updates, or wording details remain; causal and design alternatives are already resolved.",
        "One local causal or design question needs an answer under a fixed contract. Evidence can settle the cause, algorithm, repair location, or candidate's local correctness, even when the approach is known.",
        "Several causal or design questions affect one another under agreed requirements. Their consequences must be reconciled, including when reviewing an existing cross-owner design with known owners.",
        "The task requires choosing a central correctness guarantee or architectural invariant that has not been agreed. Existing patterns and local evidence cannot settle the tradeoff. Reviewing compliance with accepted guarantees leaves those guarantees fixed.",
      ],
    },
    existing_pattern_determines_change: {
      type: "noul",
      instructions: "Does an existing pattern or prior example fully determine the change requested in `task`?",
      criteria: {
        true: "A matching pattern or supplied example settles the required behavior and method; applying it leaves only routine implementation details.",
        false: "The worker must choose a local repair boundary, resolve competing designs, or reconcile contracts. A known cause alone does not determine the change. Review, extraction, and command-only tasks request no change to implement.",
      },
    },
    local_alternative_requires_resolution: {
      type: "noul",
      instructions: "Must the worker resolve a local causal or design alternative to complete `task`?",
      criteria: {
        true: "Evidence must distinguish plausible local causes, algorithms, repair locations, or candidate design choices under a fixed contract.",
        false: "A supplied solution or matching pattern settles the local choice; the worker copies literals, fills routine details, executes checks, or composes wording from settled facts.",
      },
    },
    interacting_invariants_across_owners: {
      type: "noul",
      instructions: "Does correctness in `task` require reconciling interacting invariants across owners or modules?",
      criteria: {
        true: "A behavioral choice for one owner or module constrains another's guarantee. The worker must reconcile how ordering, cancellation, identity, durability, or authorization obligations hold together.",
        false: "The worker copies settled facts, checks record counts or document parity, repeats a known change, checks independent modules, or resolves a choice wholly inside one owner's contract.",
      },
    },
    independent_correctness_judgment: {
      type: "noul",
      instructions: "Does `task` request an independent correctness or security review verdict on a candidate or design?",
      criteria: {
        true: "The assigned work is an independent review: inspect a candidate or design against requirements and return a verdict or defects. Reviewing UI evidence counts.",
        false: "The assigned work diagnoses a symptom, applies a repair, verifies a reported finding before repairing it, implements behavior, reports command output, or writes from accepted findings.",
      },
    },
    exact_literal_text_substitution: {
      type: "noul",
      instructions: "Is the requested text work in `task` limited to exact literal substitutions?",
      criteria: {
        true: "The target text and replacement wording are supplied verbatim. The worker only locates and substitutes them; wording and meaning need no decision.",
        false: "The worker must compose, explain, summarize, or select new wording; reconcile evidence or status values; extract a procedure; change code behavior; or execute commands without text substitutions.",
      },
    },
    scope: {
      type: "choice",
      instructions: "What area must the worker change or inspect to complete `task`?",
      criteria: {
        single_file: "Required work is confined to one file or document.",
        one_module: "Required work covers one module or package and can include several files.",
        several_modules: "Required work covers several modules within one repository.",
        several_repositories_or_services: "Required work covers several repositories or services.",
        administrative_not_applicable: "The task operates on issue states or existing artifacts without file/module inspection or changes. File and module scope does not describe the work.",
      },
    },
    needs_root_cause_diagnosis: {
      type: "noul",
      instructions: "Does completing `task` require discovering why an observed failure or unexpected behavior occurs?",
      criteria: {
        true: "An unexplained symptom must be traced to its cause before the requested outcome can be delivered.",
        false: "The cause and repair are supplied; the task adds specified behavior, writes documentation from settled facts, executes given checks, or reviews a candidate against known requirements.",
      },
    },
    concurrency_or_security_invariant_is_open: {
      type: "noul",
      instructions: "Must the worker establish a concurrency or security invariant that `task` leaves unsettled?",
      criteria: {
        true: "The worker must determine or independently justify event ordering, shared-state safety, liveness, authorization, input trust, or a security boundary.",
        false: "The invariant and applicable repair pattern are supplied. The worker preserves them while applying a known change, executes fixed checks, or works on sequential behavior or prose.",
      },
    },
    requires_frontend_ui_expertise: {
      type: "noul",
      instructions: "Does the work in `task` require frontend/UI expertise (change or review UI code, layout, styling, or rendered UI)?",
      criteria: {
        true: "The task changes or reviews frontend behavior, components, value formatters, UX, CSS, layout, animation, or design systems. Examples: repair a UI event handler; adjust table columns; judge screenshots or rendered UI evidence. Fully specified frontend changes count.",
        false: "The task concerns backend behavior, CLI command execution, administrative records, or prose about a UI without changing or reviewing UI code or rendered evidence. Merely mentioning a UI does not require UI expertise.",
      },
    },
    enough_information_to_judge: {
      type: "noul",
      instructions: "Does `task` provide enough information to understand what the worker must do?",
      criteria: {
        true: "The supplied prompt or included brief states an actionable goal and substantive work. A difficult investigation is sufficiently described even though its solution is unknown.",
        false: "Only a title, unexplained identifier, or reference to an absent brief is supplied; essential instructions needed to understand the requested work are missing.",
      },
    },
  } as const
}

// Frozen model data follows the byte-identical questions-v2.ts above.
export const QUESTIONS_HASH = "615db111c1a22545732d05b35a2c31fdb1b6445292e8861a90a8bcd526a39c75"
export const FROZEN_ROUTER = {
  features: ["jev.kind_of_work.code_change", "jev.kind_of_work.documentation_prose", "jev.kind_of_work.investigation_only", "jev.kind_of_work.other", "jev.kind_of_work.review_judgment", "jev.kind_of_work.verification_run", "jev.kind_of_work.visual_ui", "jev.approach_is_known", "jev.owner_is_known", "jev.how_settled.0", "jev.how_settled.1", "jev.how_settled.2", "jev.how_settled.3", "jev.how_settled.4", "jev.existing_pattern_determines_change", "jev.local_alternative_requires_resolution", "jev.interacting_invariants_across_owners", "jev.independent_correctness_judgment", "jev.exact_literal_text_substitution", "jev.scope.administrative_not_applicable", "jev.scope.one_module", "jev.scope.several_modules", "jev.scope.several_repositories_or_services", "jev.scope.single_file", "jev.needs_root_cause_diagnosis", "jev.concurrency_or_security_invariant_is_open", "jev.requires_frontend_ui_expertise", "jev.enough_information_to_judge"],
  classes: ["deep-low", "quick", "unspecified-high", "unspecified-low", "visual-engineering", "writing"],
  means: [0.2935395189003436, 0.16068728522336773, 0.10697594501718213, 0.1016151202749141, 0.07257731958762886, 0.19848797250859107, 0.06611683848797252, 0.9596563573883161, 0.9145360824742268, 0.1475601374570447, 0.49202749140893476, 0.20632302405498282, 0.1483848797250859, 0.005704467353951891, 0.3243298969072165, 0.3392439862542955, 0.4926460481099656, 0.11938144329896908, 0.03494845360824742, 0.08350515463917527, 0.2508591065292096, 0.40075601374570446, 0.10924398625429553, 0.1556357388316151, 0.18082474226804127, 0.17972508591065292, 0.19079037800687282, 0.9541237113402061],
  scales: [0.4209768312205683, 0.3308006664195623, 0.27813776180452865, 0.22468565971603574, 0.2420641973460793, 0.3705041364781717, 0.2194691504477389, 0.038510302800457516, 0.08536182080199772, 0.2690863228271314, 0.3244519766542891, 0.21869313211316624, 0.23002122189162935, 0.015188459196295233, 0.20893400140050564, 0.30503356627292993, 0.3517021083244263, 0.24093951744075429, 0.067956783993475, 0.18238044845953896, 0.28382442919789513, 0.337513821414717, 0.20986359239346034, 0.3069221858037367, 0.26773840942730937, 0.20217186733357292, 0.3528242371392809, 0.0325993878883225],
  coefficients: [
    [0.09948353312450707, -0.15806446782012773, 0.15427593739112566, 0.12161488212483437, -0.0070573481638953215, -0.12136187975699837, -0.05993601097349661, -0.12923327722052985, 0.03871370846608455, -0.0980972539635913, -0.3218230298016731, 0.35955099277873137, 0.2170742857623529, 0.14812050741707042, 0.047649530615311346, 0.49937034108963857, 0.06419821825464628, 0.046431543085433576, -0.03527602563831563, -0.11953905652711312, 0.16930334529746854, 0.10373658628845851, -0.24381919900838944, -0.03288976075941501, 0.12862272715813594, 0.2301865108816148, -0.3423263303781031, -0.002703791247910104],
    [-0.19675872729247315, -0.20137663963213107, -0.16666065153553752, 0.05206305409778068, -0.11995936478608935, 0.6053113794209838, -0.05071014078553487, 0.033827867722413474, 0.09139650397203489, 0.6274860697671079, -0.34823938817243544, -0.055118087114368206, -0.18721188216601473, -0.0490048590345855, 0.05337398014162775, -0.22178446240017205, -0.20289881592606096, -0.1492692157801725, 0.19852860286672752, 0.2991625389368263, 0.03237623281045499, -0.253395598004586, -0.10888571043785289, 0.14539548204226183, -0.11163992006066124, -0.1997619818082902, -0.2769487676665291, 0.1302501064596766],
    [0.32395951100074427, -0.07549876774714084, -0.00271992030492061, -0.2012542682458792, 0.07475718116740697, -0.2090329329618438, -0.027691435644030794, -0.04242673275525697, -0.2371909029754993, -0.05620350579134311, 0.04502615277530338, -0.21279966327161262, 0.19870440522120555, 0.08864396356241705, -0.14895882473549057, 0.29875348650757394, 0.4311481295377709, 0.10007489947047635, 0.0022891360176220225, -0.16607375440817967, -0.1250506779359149, 0.15815986695967682, 0.34987639253854047, -0.19883350716958606, 0.07120878085645302, 0.3548258215876248, -0.249455228425511, 0.002017775542937869],
    [0.17455478480876108, -0.5336042791384152, 0.26097721301062055, -0.0243162545801619, 0.09979821001459842, 0.06712394511091004, -0.059772620178171, 0.08135051349451913, 0.027137684966904496, -0.3262111134322045, 0.42073927134612926, -0.019911147636146886, -0.18544266653231786, -0.11328069925736639, 0.08189275783038934, -0.35813585346393434, -0.08352908078437257, -0.061815038483780727, -0.14680233927770237, 0.1302716866043236, -0.1428576206475808, 0.07737740117597397, 0.0862217593148895, -0.08934928060069791, 0.05082573083286648, -0.13373596876787996, -0.3986865267399542, -0.3006371888718034],
    [-0.037104854379650366, -0.11648210186491484, 0.018673172625008422, 0.051051784150338925, -0.04397008672743602, -0.03153532297465964, 0.27254798197137237, -0.08338880847237896, 0.019839927652845736, -0.010436138446005848, -0.005520754469248784, -0.01698913620508099, 0.03878140585637283, -0.039878774154927854, -0.057589556885572164, -0.04164993174792433, -0.0579971200939958, 0.14854739678460294, 0.18381770406644038, -0.21332739183162536, 0.05208937724975136, -0.05296593823929285, -0.08438809747364277, 0.19454192592965677, 0.009503798583387697, -0.0028054576711369103, 1.4484068119135198, 0.012288691444782231],
    [-0.3641342472618889, 1.0850262562027304, -0.2645457511862962, 0.0008408024530873155, -0.0035685915045847068, -0.31050518883839173, -0.07443777439013927, 0.13987043723123327, 0.06010307791762963, -0.13653805813396322, 0.20981774832192515, -0.054732958551522735, -0.0819055481415986, -0.03460013853260798, 0.023632113033734452, -0.1765535799851818, -0.15092133098798766, -0.0839695850765598, -0.2025570780347722, 0.06950597722576862, 0.0141393432258209, -0.032912318180230306, 0.0009948550664547362, -0.018864859442219637, -0.1485211173701816, -0.2487089242219327, -0.18098995870342208, 0.1587844066723164],
  ],
  intercepts: [-0.3290592350682311, -0.1605749432120769, -0.5948600470073542, 0.9030643051940257, 0.43160528225927475, -0.25017536216563696],
} as const

import { z } from "zod"

const probability = z.number().min(0).max(1)
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }).strict(),
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability, probabilities: z.record(z.string(), probability) }).strict(),
  z.object({ type: z.literal("score"), score: z.number().min(0).max(4), confidence: probability, probabilities: z.record(z.string(), probability), legend: z.record(z.string(), z.string()) }).strict(),
])
const responseSchema = z.object({
  model: z.string().min(1),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
  answers: z.record(z.string(), answerSchema),
})

export type JevRouterWeights = {
  readonly features: readonly string[]
  readonly classes: readonly string[]
  readonly means: readonly number[]
  readonly scales: readonly number[]
  readonly coefficients: readonly (readonly number[])[]
  readonly intercepts: readonly number[]
}

export function parseJevCategoryResponse(raw: unknown, router: JevRouterWeights = FROZEN_ROUTER) {
  const response = responseSchema.parse(raw)
  const battery = questions()
  if (Object.keys(response.answers).length !== Object.keys(battery).length) throw new RangeError("Malformed answer count")
  const numeric: Record<string, number | number[]> = {}
  const features = new Map<string, number>()
  for (const [name, question] of Object.entries(battery)) {
    const answer = response.answers[name]
    if (!answer || answer.type !== question.type) throw new RangeError("Malformed answer type")
    switch (answer.type) {
      case "noul":
        numeric[name] = answer.noul
        features.set(`jev.${name}`, answer.noul)
        break
      case "choice":
      case "score": {
        const keys = question.type === "score" ? question.criteria.map((_, index) => String(index)) : Object.keys(question.criteria)
        if (Object.keys(answer.probabilities).length !== keys.length
          || keys.some(key => !Object.hasOwn(answer.probabilities, key))
          || Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.025
          || (answer.type === "choice" && !keys.includes(answer.choice))) throw new RangeError("Malformed probabilities")
        numeric[name] = keys.map(key => answer.probabilities[key])
        for (const key of keys) features.set(`jev.${name}.${key}`, answer.probabilities[key])
        break
      }
      default: {
        const exhaustive: never = answer
        throw new RangeError(`Unexpected answer: ${exhaustive}`)
      }
    }
  }
  const vector = router.features.map(name => {
    const value = features.get(name)
    if (value === undefined) throw new RangeError("Missing model feature")
    return value
  })
  return { model: response.model, inputTokens: response.usage.input_tokens, answers: numeric, ranking: inferJevCategory(vector, router) }
}

export function inferJevCategory(vector: readonly number[], router: JevRouterWeights = FROZEN_ROUTER) {
  if (vector.length !== router.features.length || vector.some(value => !Number.isFinite(value))) throw new RangeError("Invalid model vector")
  const scaled = vector.map((value, index) => (value - router.means[index]) / router.scales[index])
  const logits = router.coefficients.map((row, index) => row.reduce<number>((sum, coefficient, feature) => sum + coefficient * scaled[feature], router.intercepts[index]))
  const maximum = Math.max(...logits)
  const exps = logits.map(logit => Math.exp(logit - maximum))
  const total = exps.reduce((sum, value) => sum + value, 0)
  return router.classes.map((category, index) => ({ category, probability: exps[index] / total }))
    .sort((a, b) => b.probability - a.probability)
}
