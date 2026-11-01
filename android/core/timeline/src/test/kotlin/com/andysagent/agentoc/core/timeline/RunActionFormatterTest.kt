package com.andysagent.agentoc.core.timeline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunActionFormatterTest {
    @Test fun realToolSupersedesStaleRespondingSnapshotButNotANewerCanonicalUpdate() {
        val activity = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"state":"working","kind":"responding","sourceSeq":10,"runId":"run-a"}"""
        ) as kotlinx.serialization.json.JsonObject
        val tool = TimelineItem.Operation("read", 11, TimelineOperationKind.Command, "Read", "cat README.md",
            TimelineOperationStatus.InProgress, runId = "run-a")
        fun project(status: RunActionFormatter.RunActionStatus, event: TimelineItem.Operation) =
            RunActionFormatter.project(status, null, listOf(event), activity, "run-a")
        assertEquals("Reading README.md", project(RunActionFormatter.RunActionStatus.Working, tool)?.sentence)
        assertEquals("Responding", project(RunActionFormatter.RunActionStatus.Working, tool.copy(seq = 9))?.sentence)
        assertEquals("Waiting for approval", project(RunActionFormatter.RunActionStatus.WaitingApproval, tool)?.sentence)
        assertEquals(null, project(RunActionFormatter.RunActionStatus.Other, tool))
    }

    @Test fun canonicalActivityKeepsTheConcreteToolSubjectAndProviderWait() {
        val json = kotlinx.serialization.json.Json
        val activity = json.parseToJsonElement("""{"state":"working","kind":"read","subject":"README.md","detail":"/work/README.md","runId":"run-a","providerLiveness":{"phase":"awaiting_provider_output"}}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Reading README.md · waiting for provider output", RunActionFormatter.fromServer(activity, "run-a")?.sentence)
        assertEquals(null, RunActionFormatter.fromServer(activity, "other-run"))
        val approval = json.parseToJsonElement("""{"state":"waiting_user","kind":"approval","subject":"git push","operationId":"approval-op"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Waiting for approval git push", RunActionFormatter.fromServer(approval)?.sentence)
        assertEquals("approval-op", RunActionFormatter.fromServer(approval)?.operationId)
        val response = json.parseToJsonElement("""{"state":"working","kind":"responding","detail":"Actual assistant response text"}""") as kotlinx.serialization.json.JsonObject
        assertEquals("Responding", RunActionFormatter.fromServer(response)?.sentence)
    }

    @Test fun progressPlansMatchTheirRunAndDisappearAfterTheLastStep() {
        val plan = TimelineItem.Plan("plan", 1, "plan", "Task", "running", 1,
            items = listOf(PlanStepItem("Read files", "completed"), PlanStepItem("Run checks", "in_progress")),
            planIntent = "progress", runId = "run-a")
        assertEquals("1/2 · Run checks", RunActionFormatter.fromProgressPlan(listOf(plan), "run-a")?.sentence)
        assertEquals(null, RunActionFormatter.fromProgressPlan(listOf(plan), "other-run"))
        assertEquals(null, RunActionFormatter.fromProgressPlan(listOf(plan.copy(items = plan.items.map { it.copy(status = "completed") })), "run-a"))
    }

    @Test
    fun posixReadUsesFileNameAndKeepsDetail() {
        val result = format("cat src/main/App.kt")
        assertEquals("read", result?.kind)
        assertEquals("Reading App.kt", result?.sentence)
        assertEquals("cat src/main/App.kt", result?.detail)
    }

    @Test
    fun powershellReadUsesWindowsBasename() {
        val result = format("Get-Content C:\\work\\report.csv")
        assertEquals("read", result?.kind)
        assertEquals("Reading report.csv", result?.sentence)
    }

    @Test
    fun cmdSearchIsHumanReadable() {
        val result = format("findstr invoice C:\\work")
        assertEquals("search", result?.kind)
        assertTrue(result?.sentence?.startsWith("Searching invoice in") == true)
    }

    @Test
    fun gitStatusAndFileEditAreSemantic() {
        assertEquals("Inspecting workspace status", format("git status")?.sentence)
        val edit = TimelineItem.Operation(
            id = "edit-1",
            seq = 2,
            kind = TimelineOperationKind.FileEdit,
            title = "src/main/App.kt",
            detail = "-old\n+new",
            status = TimelineOperationStatus.InProgress,
        )
        assertEquals("Editing App.kt", RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, null, listOf(edit))?.sentence)
    }

    @Test
    fun workingWithoutOperationFallsBackToPhaseAndTerminalClears() {
        assertEquals(
            "Planning the next step",
            RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, "planning", emptyList())?.sentence,
        )
        assertEquals(null, RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Other, null, emptyList()))
    }

    private fun format(command: String): RunActionUiState? = RunActionFormatter.forRun(
        status = RunActionFormatter.RunActionStatus.Working,
        phase = null,
        items = listOf(
            TimelineItem.Operation(
                id = "op-1",
                seq = 1,
                kind = TimelineOperationKind.Command,
                title = "Run command",
                detail = command,
                status = TimelineOperationStatus.InProgress,
            ),
        ),
    )
}
