"""Verify cancellation windows from the device's phase-transition timestamps."""
import json
import unittest
from action_scenarios import demo_hold_windows


def state(at, stage, phase='IDLE', demo=True):
    return f"{at:.3f} 1 1 I Mobi : STATE " + json.dumps({'demo': demo, 'actionStage': stage, 'voicePhase': phase})


class DemoHoldTimingTest(unittest.TestCase):
    def test_uses_actual_clip_completion_and_ignores_preplay_idle(self):
        log='\n'.join([state(100,'HOLDING'), state(100.1,'HOLDING','SPEAKING'),
                       state(106.5,'HOLDING'),state(109,'HOLDING'),state(116.501,'PROCESSING')])
        self.assertEqual([10001],demo_hold_windows(log))

    def test_does_not_count_cancelled_or_non_demo_holds(self):
        log='\n'.join([state(100,'HOLDING','SPEAKING'),state(105,'HOLDING'),state(106,'CANCELLING'),
                       state(107,'PROCESSING'),state(200,'HOLDING','SPEAKING',False),
                       state(205,'HOLDING',demo=False),state(215,'PROCESSING',demo=False)])
        self.assertEqual([],demo_hold_windows(log))

    def test_reports_each_successful_hold_independently(self):
        log='\n'.join([state(1,'HOLDING','SPEAKING'),state(5,'HOLDING'),state(15,'PROCESSING'),
                       state(20,'HOLDING','SPEAKING'),state(26,'HOLDING'),state(36.25,'PROCESSING')])
        self.assertEqual([10000,10250],demo_hold_windows(log))
