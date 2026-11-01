package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalAction
import com.andysagent.agentoc.core.model.AttentionItem
import com.andysagent.agentoc.core.model.AttentionKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AttentionPresentationTest {
    private val approval = Approval("a", "s", "Export report", reason = "Writes a shared report", actions = listOf(
        ApprovalAction("one", description = "Export sources", summary = "Export audited report", command = "export --sources", cwd = "C:/Reports")))
    private val item = AttentionItem("i", "s", "Weekly report", AttentionKind.Approval, "Export report", "Export report", approval = approval)

    @Test fun `operation and real consequence have distinct roles`() {
        assertEquals(ApprovalPresentation("Export audited report", "Writes a shared report"), approvalPresentation(item))
        assertEquals(ApprovalPresentation("Export report", null), approvalPresentation(item.copy(approval = approval.copy(actions = emptyList(), reason = "Export report"))))
    }

    @Test fun `selectable actions are not repeated in technical list and full payload is retained`() {
        val inline = approvalDetails(item, skipActionList = false)
        assertTrue(inline.any { it.value == "export --sources" })
        assertTrue(inline.any { it.value == "C:/Reports" })
        val batch = approvalDetails(item, skipActionList = true)
        assertFalse(batch.any { it.value == "export --sources" || it.value == "Export audited report" })
        assertTrue(batch.any { it.value == "Writes a shared report" })
    }

    @Test fun `reveal has continuous geometry and bounded endpoints`() {
        assertEquals(0, attentionDisclosureHeight(200, -1f))
        assertEquals(100, attentionDisclosureHeight(200, .5f))
        assertEquals(200, attentionDisclosureHeight(200, 2f))
        assertEquals(0, attentionDisclosureHeight(-200, .5f))
    }
}
