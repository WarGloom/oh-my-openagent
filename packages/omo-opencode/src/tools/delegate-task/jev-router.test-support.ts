import { FROZEN_ROUTER, MODEL, questions } from "./jev-router-model"

export const frozenVectors = [
  {
    id: "prt_1360e394e001AJArOiWPWI3Hd0",
    vector: [
      0.04, 0, 0, 0, 0, 0, 0.96, 0.81, 0.82, 0, 0.25, 0.2, 0.52, 0.03, 0.15, 0.72, 0.59, 0.02, 0.01, 0, 0.64, 0.31, 0,
      0.05, 0.11, 0.39, 0.99, 0.58,
    ],
    expected: "visual-engineering",
    probabilities: [
      0.019276985882743423, 0.00013223182585729026, 0.007946653278263827, 0.02266300620888163, 0.9498822231532074,
      0.00009889965104636886,
    ],
  },
  {
    id: "prt_187ef5d97001c4BkLOie6RouOW",
    vector: [
      0, 0.96, 0, 0.04, 0, 0, 0, 0.94, 0.96, 0.01, 0.84, 0.12, 0.03, 0, 0.34, 0.07, 0.16, 0.03, 0.01, 0.01, 0.2, 0.37,
      0.01, 0.41, 0.03, 0.04, 0.01, 0.92,
    ],
    expected: "writing",
    probabilities: [
      0.003519056881165241, 0.011163957603113131, 0.002609099323689913, 0.05581871552903989, 0.014422006662860727,
      0.9124671640001312,
    ],
  },
  {
    id: "prt_0a5a9a419001pT5iKYH2v7hYNQ",
    vector: [
      1, 0, 0, 0, 0, 0, 0, 0.94, 0.97, 0, 0.21, 0.56, 0.2, 0.03, 0.13, 0.9, 0.93, 0.05, 0.02, 0, 0.71, 0.29, 0, 0, 0.2,
      0.2, 0.01, 0.98,
    ],
    expected: "deep-low",
    probabilities: [
      0.779583991865775, 0.012730481623576215, 0.1305761136911602, 0.036374176029593745, 0.03153482107308386,
      0.009200415716810751,
    ],
  },
] as const

export function categoryReply(vector: readonly number[] = frozenVectors[0].vector) {
  const features = new Map(FROZEN_ROUTER.features.map((name, index) => [String(name), vector[index]]))
  const answers = Object.fromEntries(
    Object.entries(questions()).map(([name, question]) => {
      switch (question.type) {
        case "noul":
          return [name, { type: "noul", noul: features.get(`jev.${name}`) }]
        case "choice":
        case "score": {
          const keys =
            question.type === "score"
              ? question.criteria.map((_, index) => String(index))
              : Object.keys(question.criteria)
          const probabilities = Object.fromEntries(keys.map((key) => [key, features.get(`jev.${name}.${key}`)]))
          return [
            name,
            question.type === "score"
              ? {
                  type: "score",
                  score: 1,
                  confidence: 0.8,
                  probabilities,
                  legend: Object.fromEntries(question.criteria.map((text, index) => [index, text])),
                }
              : { type: "choice", choice: keys[0], confidence: 0.8, probabilities },
          ]
        }
        default: {
          const exhaustive: never = question
          throw new RangeError(`Unexpected question: ${exhaustive}`)
        }
      }
    }),
  )
  return { model: MODEL, usage: { input_tokens: 2345, output_tokens: 0 }, answers }
}
