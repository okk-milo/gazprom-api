import unittest
from measure_audio import summarise


class AudioMeasurements(unittest.TestCase):
    def test_internal_pauses_not_leading_or_trailing_silence(self):
        result = summarise([{"start": 16000, "end": 32000}, {"start": 80000, "end": 96000}], 160000)
        self.assertEqual(result["voicedMs"], 2000)
        self.assertEqual(result["longPauseMs"], 3000)
        self.assertEqual(result["longPauseCount"], 1)

    def test_short_gaps_not_counted(self):
        result = summarise([{"start": 0, "end": 16000}, {"start": 20000, "end": 36000}], 48000)
        self.assertEqual(result["longPauseMs"], 0)
        self.assertEqual(result["longPauseCount"], 0)

    def test_two_seconds_is_inclusive(self):
        result = summarise([{"start": 0, "end": 16000}, {"start": 48000, "end": 64000}], 64000)
        self.assertEqual(result["longPauseMs"], 2000)

    def test_invalid_or_overlapping_ranges_rejected(self):
        for ranges in [[{"start": 100, "end": 99}], [{"start": 0, "end": 200000}],
                       [{"start": 0, "end": 1000}, {"start": 500, "end": 1500}]]:
            with self.assertRaises(ValueError):
                summarise(ranges, 160000)

    def test_no_speech_is_zero_activity_not_full_length(self):
        self.assertEqual(summarise([], 160000)["voicedMs"], 0)


if __name__ == "__main__":
    unittest.main()
