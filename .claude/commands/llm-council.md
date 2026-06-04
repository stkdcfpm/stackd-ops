---
name: llm-council
description: "Run any question, idea, or decision through a council of 5 AI advisors who independently analyze it, peer-review each other anonymously, and synthesize a final verdict. Based on Karpathy's LLM Council methodology. MANDATORY TRIGGERS: 'council this', 'run the council', 'war room this', 'pressure-test this', 'stress-test this', 'debate this'. STRONG TRIGGERS (use when combined with a real decision or tradeoff): 'should I X or Y', 'which option', 'what would you do', 'is this the right move', 'validate this', 'get multiple perspectives', 'I can't decide', 'I'm torn between'. Do NOT trigger on simple yes/no questions, factual lookups, or casual 'should I' without a meaningful tradeoff (e.g. 'should I use markdown' is not a council question). DO trigger when the user presents a genuine decision with stakes, multiple options, and context that suggests they want it pressure-tested from multiple angles."
---

# LLM Council

You ask one AI a question, you get one answer. That answer might be great. It might be mid. You have no way to tell because you only saw one perspective.

The council fixes this. It runs your question through 5 independent advisors, each thinking from a fundamentally different angle. Then they review each other's work. Then a chairman synthesizes everything into a final recommendation that tells you where the advisors agree, where they clash, and what you should actually do.

This is adapted from Andrej Karpathy's LLM Council. He dispatches queries to multiple models, has them peer-review each other anonymously, then a chairman produces the final answer. We do the same thing inside Claude using sub-agents with different thinking lenses instead of different models.

---

## When to run the council

The council is for questions where being wrong is expensive.

**Good council questions:**
- "Should I launch a $97 workshop or a $497 course?"
- "Which of these 3 positioning angles is strongest?"
- "I'm thinking of pivoting from X to Y. Am I crazy?"
- "Here's my landing page copy. What's weak?"
- "Should I hire a VA or build an automation first?"

**Bad council questions:**
- "What's the capital of France?" (one right answer, no need for perspectives)
- "Write me a tweet" (creation task, not a decision)
- "Summarize this article" (processing task, not judgment)

The council shines when there's genuine uncertainty and the cost of a bad call is high.

---

## The five advisors

### 1. The Contrarian
Actively looks for what's wrong, what's missing, what will fail. Assumes the idea has a fatal flaw and tries to find it. If everything looks solid, digs deeper. Not a pessimist — the friend who saves you from a bad deal by asking the questions you're avoiding.

### 2. The First Principles Thinker
Ignores the surface-level question and asks "what are we actually trying to solve here?" Strips away assumptions. Rebuilds the problem from the ground up. Sometimes the most valuable output is saying "you're asking the wrong question entirely."

### 3. The Expansionist
Looks for upside everyone else is missing. What could be bigger? What adjacent opportunity is hiding? What's being undervalued? Does not care about risk — cares about what happens if this works even better than expected.

### 4. The Outsider
Has zero context about you, your field, or your history. Responds purely to what's in front of them. Catches the curse of knowledge: things obvious to you but confusing to everyone else. The most underrated advisor.

### 5. The Executor
Only cares about one thing: can this actually be done, and what's the fastest path? Ignores theory and big-picture thinking. Looks at every idea through "OK but what do you do Monday morning?" If an idea has no clear first step, the Executor will say so.

**Why these five:** Three natural tensions. Contrarian vs Expansionist (downside vs upside). First Principles vs Executor (rethink everything vs just do it). The Outsider sits in the middle keeping everyone honest.

---

## How a council session works

### Step 1: Frame the question (with context enrichment)

When triggered, do two things before framing:

**A. Scan the workspace for context.** Read any relevant files:
- `CLAUDE.md` or `claude.md` in the project root (business context, preferences, constraints)
- Any `memory/` folder (audience profiles, voice docs, business details, past decisions)
- Files the user explicitly referenced or attached
- Any other files relevant to the specific question

Use `Glob` and quick `Read` calls to find these. Don't spend more than 30 seconds on this.

**B. Frame the question.** Reframe as a clear, neutral prompt including:
1. The core decision or question
2. Key context from the user's message
3. Key context from workspace files (business stage, audience, constraints, past results, relevant numbers)
4. What's at stake (why this decision matters)

Don't add your own opinion. Don't steer it. If the question is too vague, ask one clarifying question — just one.

### Step 2: Convene the council (5 sub-agents in parallel)

Spawn all 5 advisors simultaneously as sub-agents. Each gets their advisor identity, the framed question, and this instruction: respond independently, do not hedge, lean fully into your assigned perspective. 150–300 words each.

**Sub-agent prompt template:**
```
You are [Advisor Name] on an LLM Council.

Your thinking style: [advisor description]

A user has brought this question to the council:

---
[framed question]
---

Respond from your perspective. Be direct and specific. Don't hedge or try to be balanced. Lean fully into your assigned angle. The other advisors will cover the angles you're not covering.

Keep your response between 150-300 words. No preamble. Go straight into your analysis.
```

### Step 3: Peer review (5 sub-agents in parallel)

Collect all 5 advisor responses. Anonymize as Response A through E (randomize mapping to remove positional bias).

Spawn 5 new sub-agents. Each reviewer sees all 5 anonymized responses and answers:
1. Which response is the strongest and why? (pick one)
2. Which response has the biggest blind spot and what is it?
3. What did ALL responses miss that the council should consider?

**Reviewer prompt template:**
```
You are reviewing the outputs of an LLM Council. Five advisors independently answered this question:

---
[framed question]
---

Here are their anonymized responses:

**Response A:** [response]
**Response B:** [response]
**Response C:** [response]
**Response D:** [response]
**Response E:** [response]

Answer these three questions. Be specific. Reference responses by letter.

1. Which response is the strongest? Why?
2. Which response has the biggest blind spot? What is it missing?
3. What did ALL five responses miss that the council should consider?

Keep your review under 200 words. Be direct.
```

### Step 4: Chairman synthesis

One agent gets everything: the original question, all 5 de-anonymized advisor responses, and all 5 peer reviews.

**Chairman prompt template:**
```
You are the Chairman of an LLM Council. Your job is to synthesize the work of 5 advisors and their peer reviews into a final verdict.

The question brought to the council:
---
[framed question]
---

ADVISOR RESPONSES:

**The Contrarian:** [response]
**The First Principles Thinker:** [response]
**The Expansionist:** [response]
**The Outsider:** [response]
**The Executor:** [response]

PEER REVIEWS:
[all 5 peer reviews]

Produce the council verdict using this exact structure:

## Where the Council Agrees
[Points multiple advisors converged on independently. These are high-confidence signals.]

## Where the Council Clashes
[Genuine disagreements. Present both sides. Explain why reasonable advisors disagree.]

## Blind Spots the Council Caught
[Things that only emerged through peer review. Things individual advisors missed that others flagged.]

## The Recommendation
[A clear, direct recommendation. Not "it depends." A real answer with reasoning.]

## The One Thing to Do First
[A single concrete next step. Not a list. One thing.]

Be direct. Don't hedge. The whole point of the council is to give the user clarity they couldn't get from a single perspective.
```

### Step 5: Present the verdict in chat

Present the full verdict directly in chat using markdown. Do NOT generate HTML files. Format:

```
## Council Verdict: {short topic}

### Where the Council Agrees
{content}

### Where the Council Clashes
{content}

### Blind Spots the Council Caught
{content}

### The Recommendation
{content}

### The One Thing to Do First
{content}
```

### Step 6: Save the transcript (optional)

Only save a transcript if the user asks or the question is significant enough to reference later. If saving, write to `council-transcript-[timestamp].md` in the project's `active/` directory.

---

## Important notes

- **Always spawn all 5 advisors in parallel.** Sequential spawning wastes time and lets earlier responses bleed into later ones.
- **Always anonymize for peer review.** If reviewers know which advisor said what, they'll defer to certain thinking styles instead of evaluating on merit.
- **The chairman can disagree with the majority.** If 4 out of 5 say "do it" but the dissenter's reasoning is strongest, the chairman should side with the dissenter and explain why.
- **Don't council trivial questions.** If the user asks something with one right answer, just answer it.
