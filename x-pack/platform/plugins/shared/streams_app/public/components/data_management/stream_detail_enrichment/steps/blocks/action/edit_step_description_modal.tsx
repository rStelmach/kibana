/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiFormRow,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiText,
  EuiTextArea,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import type { StreamlangProcessorDefinitionWithUIAttributes } from '@kbn/streamlang';
import { getStepDescription } from './utils';

export interface EditStepDescriptionModalProps {
  step: StreamlangProcessorDefinitionWithUIAttributes;
  onSave: (description: string) => void;
  onCancel: () => void;
}

export const EditStepDescriptionModal: React.FC<EditStepDescriptionModalProps> = ({
  step,
  onSave,
  onCancel,
}) => {
  const initialValue = useMemo(() => {
    if (step.description && step.description.trim().length > 0) {
      return step.description;
    }

    // Use the auto-generated metadata description as the starting point,
    // ignoring any existing custom description override.
    return getStepDescription({
      ...step,
      description: undefined,
    } as StreamlangProcessorDefinitionWithUIAttributes);
  }, [step]);

  const [value, setValue] = useState(initialValue);

  const handleSave = () => {
    onSave(value);
  };

  return (
    <EuiModal onClose={onCancel} data-test-subj="streamsEditStepDescriptionModal">
      <EuiModalHeader>
        <EuiModalHeaderTitle>
          {i18n.translate('xpack.streams.enrichment.processor.editDescription.title', {
            defaultMessage: 'Edit description',
          })}
        </EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        <EuiText size="s" color="subdued">
          <p>
            {i18n.translate('xpack.streams.enrichment.processor.editDescription.helpText', {
              defaultMessage:
                'Explain this step, this overrides the generated metadata. If you remove the description, the metadata will appear again.',
            })}
          </p>
        </EuiText>
        <EuiFormRow
          fullWidth
          label={i18n.translate(
            'xpack.streams.enrichment.processor.editDescription.fieldLabel',
            { defaultMessage: 'Description' }
          )}
        >
          <EuiTextArea
            fullWidth
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-test-subj="streamsEditStepDescriptionTextarea"
          />
        </EuiFormRow>
      </EuiModalBody>
      <EuiModalFooter>
        <EuiButtonEmpty onClick={onCancel}>
          {i18n.translate(
            'xpack.streams.enrichment.processor.editDescription.cancelButtonLabel',
            { defaultMessage: 'Cancel' }
          )}
        </EuiButtonEmpty>
        <EuiButton
          onClick={handleSave}
          fill
          data-test-subj="streamsEditStepDescriptionConfirmButton"
        >
          {i18n.translate(
            'xpack.streams.enrichment.processor.editDescription.confirmButtonLabel',
            { defaultMessage: 'Edit description' }
          )}
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
};



