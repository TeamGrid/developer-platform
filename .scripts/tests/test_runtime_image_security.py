import datetime as dt
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('image_security', ROOT / '.scripts/runtime-image-security.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeImageSecurityTests(unittest.TestCase):
    def report(self, findings=None, category='lang-pkgs'):
        return {'Metadata': {'OS': {'Family': 'debian', 'Name': '13'}},
                'Results': [{'Class': 'os-pkgs', 'Type': 'debian', 'Target': 'os', 'Packages': [{'Name': 'base-files'}]}, {'Class': category, 'Type': 'node-pkg' if category == 'lang-pkgs' else 'debian',
                             'Target': 'fixture', 'Packages': [{'Name': 'fixture'}], 'Vulnerabilities': findings or []}]}

    def finding(self, severity, fixed=''):
        return {'VulnerabilityID': 'CVE-2026-FIXTURE', 'PkgName': 'fixture', 'InstalledVersion': '1.0.0',
                'FixedVersion': fixed, 'Severity': severity, 'Status': 'affected'}

    def verify(self, report, age=0):
        now = dt.datetime(2026, 10, 24, 18, tzinfo=dt.timezone.utc)
        db = {'UpdatedAt': (now - dt.timedelta(seconds=age)).isoformat().replace('+00:00', 'Z')}
        return module.verify_scan(report, db, now)

    def test_clean_detected_package_graph(self):
        result = self.verify(self.report())
        self.assertEqual(result['blockingFindings'], [])
        self.assertEqual(result['packagesDetected'], 2)

    def test_unfixed_high_library_still_blocks(self):
        self.assertEqual(len(self.verify(self.report([self.finding('HIGH')]))['blockingFindings']), 1)

    def test_fixed_moderate_library_blocks(self):
        self.assertEqual(len(self.verify(self.report([self.finding('MEDIUM', '1.0.1')]))['blockingFindings']), 1)

    def test_fixed_os_security_update_blocks(self):
        self.assertEqual(len(self.verify(self.report([self.finding('CRITICAL', '1.0.1')], 'os-pkgs'))['blockingFindings']), 1)

    def test_unfixed_os_stays_explicitly_unresolved(self):
        result = self.verify(self.report([self.finding('CRITICAL')], 'os-pkgs'))
        self.assertEqual(len(result['unresolvedVendorOsFindings']), 1)
        self.assertEqual(result['blockingFindings'], [])
        self.assertEqual(len(result['allFindings']), 1)

    def test_go_nanosecond_database_timestamp_accepted(self):
        now = dt.datetime(2026, 10, 24, 18, tzinfo=dt.timezone.utc)
        result = module.verify_scan(self.report(), {'UpdatedAt': '2026-10-24T13:07:23.340317483Z'}, now)
        self.assertEqual(result['blockingFindings'], [])

    def test_timezone_less_database_timestamp_rejected(self):
        with self.assertRaisesRegex(ValueError, 'UTC'):
            module.verify_scan(self.report(), {'UpdatedAt': '2026-10-24T13:07:23'})

    def test_stale_database_rejected(self):
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.verify(self.report(), age=86401)

    def test_future_database_rejected(self):
        with self.assertRaisesRegex(ValueError, 'future'):
            self.verify(self.report(), age=-301)

    def test_unsupported_or_missing_os_rejected(self):
        for system in [None, {'Family': 'none'}, {'Family': 'debian', 'EOSL': True}]:
            report = self.report()
            report['Metadata']['OS'] = system
            with self.assertRaises(ValueError):
                self.verify(report)

    def test_empty_results_not_success(self):
        report = self.report()
        report['Results'] = []
        with self.assertRaises(ValueError):
            self.verify(report)

    def test_no_packages_not_success(self):
        report = self.report()
        report['Results'] = [{'Class': 'os-pkgs', 'Packages': []}]
        with self.assertRaises(ValueError):
            self.verify(report)

    def test_unknown_result_class_rejected(self):
        with self.assertRaisesRegex(ValueError, 'class'):
            self.verify(self.report(category='unknown'))

    def test_missing_os_inventory_rejected(self):
        report = self.report()
        report['Results'] = report['Results'][1:]
        with self.assertRaisesRegex(ValueError, 'operating-system'):
            self.verify(report)

    def test_unknown_severity_rejected(self):
        with self.assertRaises(ValueError):
            self.verify(self.report([self.finding('NEW-UNKNOWN-SEVERITY')]))

    def test_docker_environment_never_copied_to_assessment(self):
        report = self.report()
        report['Metadata']['ImageConfig'] = {'Config': {'Env': ['SECRET=must-not-leak']}}
        self.assertNotIn('must-not-leak', str(self.verify(report)))


if __name__ == '__main__':
    unittest.main()
